import { useEffect, useRef, useState } from "react";
import { api, pollJob, projectPath } from "./api";
import { javaEntryHint } from "./projectFiles";
import type { Job, Revision, SourceFile } from "./types";

type Slots = Record<string, { run?: string; compare?: string }>;
export function entryFile(files: SourceFile[], entry?: string | null) {
  const matches = files.filter((source) => javaEntryHint(source) === entry);
  return entry && matches.length === 1 ? matches[0].path : undefined;
}
function readSlots(key: string): Slots {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([path, slots]) =>
          path &&
          slots &&
          typeof slots === "object" &&
          Object.entries(slots).every(
            ([kind, id]) =>
              ["run", "compare"].includes(kind) &&
              typeof id === "string" &&
              /^[a-f\d-]{36}$/i.test(id),
          ),
      ),
    ) as Slots;
  } catch {
    return {};
  }
}

// Store IDs only. Results and immutable launch sources are always read from the
// project-scoped API; cached browser data never establishes verification.
export default function useFileRuns(
  projectId: string,
  file: string,
  active: Job | null,
) {
  const base = projectPath(projectId);
  const key = "java-blueprints:file-runs:" + projectId;
  const [slots, setSlots] = useState<Slots>(() => readSlots(key));
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [context, setContext] = useState<{
    id: string;
    path?: string;
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const revisionCache = useRef(new Map<string, Revision>());
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(slots));
    } catch {}
  }, [key, slots]);
  useEffect(() => {
    if (active) setJobs((old) => ({ ...old, [active.id]: active }));
  }, [active]);
  const id = active?.id;
  const kind = active?.type;
  const revisionId =
    active?.revisionId ??
    active?.result?.report?.revisionId ??
    active?.result?.report?.candidateRevisionId;
  const entry = active?.entryPoint ?? active?.result?.report?.entryPoint;
  useEffect(() => {
    if (!id || (kind !== "run" && kind !== "compare")) return;
    let mounted = true;
    const controller = new AbortController();
    const resolve = async () => {
      if (!revisionId || !entry)
        throw new Error("Не удалось определить исходник запуска");
      let source = revisionCache.current.get(revisionId);
      if (!source) {
        source = await api<Revision>(`${base}/revisions/${revisionId}`, {
          signal: controller.signal,
        });
        revisionCache.current.set(revisionId, source);
      }
      const path = entryFile(source.files, entry);
      if (!mounted) return;
      setContext({
        id,
        path,
        error: path ? undefined : "Файл класса запуска не определён однозначно",
      });
      if (path) {
        setBindings((old) => ({ ...old, [id]: path }));
        setSlots((old) =>
          old[path]?.[kind] === id
            ? old
            : {
                ...old,
                [path]: { ...old[path], [kind]: id },
              },
        );
      }
    };
    void resolve().catch((error) => {
      if (mounted && error.name !== "AbortError")
        setContext({ id, error: error.message });
    });
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [base, id, kind, revisionId, entry, retry]);
  const runId = slots[file]?.run;
  const compareId = slots[file]?.compare;
  useEffect(() => {
    const controller = new AbortController();
    for (const jobId of new Set(
      [runId, compareId].filter(Boolean) as string[],
    )) {
      if (jobId === activeRef.current?.id) continue;
      void pollJob(
        async () => {
          const job = await api<Job>(`${base}/runs/${jobId}`, {
            signal: controller.signal,
          });
          if (
            job.type !== (jobId === runId ? "run" : "compare") ||
            !job.revisionId ||
            !job.entryPoint
          )
            throw new Error("У результата нет привязки к исходнику");
          let source = revisionCache.current.get(job.revisionId);
          if (!source) {
            source = await api<Revision>(
              `${base}/revisions/${job.revisionId}`,
              { signal: controller.signal },
            );
            revisionCache.current.set(job.revisionId, source);
          }
          if (entryFile(source.files, job.entryPoint) !== file)
            throw new Error("Результат относится к другому файлу");
          if (!controller.signal.aborted)
            setBindings((old) => ({ ...old, [jobId]: file }));
          return job;
        },
        controller.signal,
        (job) => {
          if (!controller.signal.aborted)
            setJobs((old) => ({ ...old, [job.id]: job }));
        },
      ).catch((error) => {
        if (error.name !== "AbortError" && !controller.signal.aborted) {
          setBindings((old) => ({ ...old, [jobId]: file }));
          setJobs((old) => ({
            ...old,
            [jobId]: {
              id: jobId,
              type: jobId === runId ? "run" : "compare",
              status: "failed",
              error: { code: "RESULT_UNAVAILABLE", message: error.message },
            },
          }));
        }
      });
    }
    return () => controller.abort();
  }, [base, file, runId, compareId, id, retry]);
  const currentContext = context?.id === id ? context : undefined;
  return {
    run: runId && bindings[runId] === file ? jobs[runId] : undefined,
    comparison:
      compareId && bindings[compareId] === file ? jobs[compareId] : undefined,
    other:
      currentContext?.path && currentContext.path !== file
        ? {
            path: currentContext.path,
            revisionId: revisionId!,
            entry,
            type: kind,
          }
        : undefined,
    resolving: !!id && !currentContext,
    error: currentContext?.error,
    retry: () => setRetry((old) => old + 1),
  };
}
