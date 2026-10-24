import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Project } from "./types";
const PAGE_SIZE = 20;
export function useProjectList(scope?: "legacy", accountId?: string) {
  const [rows, setRows] = useState<Project[]>([]),
    [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true),
    [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    pending = useRef(false);
  const loadedQuery = useRef<string | null>(null);
  const read = useCallback(
    async (after: string | undefined, ticket: number, filter: string) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      pending.current = true;
      const current = () => ticket === epoch.current && !request.signal.aborted;
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1) });
        if (scope) params.set("scope", scope);
        if (filter) params.set("q", filter);
        if (after) params.set("before", after);
        const result = await api<Project[]>("/projects?" + params, {
          signal: request.signal,
        });
        const page = result.slice(0, PAGE_SIZE);
        if (!current()) return;
        setRows((old) =>
          after
            ? Array.from(
                new Map<string, Project>(
                  [...old, ...page].map((row) => [row.id, row] as const),
                ).values(),
              )
            : page,
        );
        loadedQuery.current = filter;
        setHasMore(result.length > PAGE_SIZE);
      } catch (e) {
        if (current())
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить проекты",
          );
      } finally {
        if (controller.current === request) controller.current = null;
        if (current()) {
          pending.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [scope, accountId],
  );
  useEffect(() => {
    const ticket = ++epoch.current;
    controller.current?.abort();
    pending.current = false;
    loadedQuery.current = null;
    setRows([]);
    setHasMore(false);
    setError("");
    setLoading(true);
    setLoadingMore(false);
    const timer = setTimeout(
      () => void read(undefined, ticket, query.trim()),
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      epoch.current++;
      controller.current?.abort();
    };
  }, [query, attempt, read]);
  function loadMore() {
    if (
      loading ||
      pending.current ||
      !hasMore ||
      !rows.length ||
      loadedQuery.current !== query.trim()
    )
      return;
    setLoadingMore(true);
    setError("");
    void read(rows.at(-1)!.id, epoch.current, query.trim());
  }
  return {
    rows,
    query,
    setQuery,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    retry: () => setAttempt((n) => n + 1),
  };
}
