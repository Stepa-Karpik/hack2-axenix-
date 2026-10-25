import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Select from "./Select";
import { useAccount } from "./Account";
import { githubMessage, useGitHubStatus } from "./github";
export interface GitHubImportPreview {
  files: { path: string; content: string }[];
  directories: string[];
  provenance?: Record<string, unknown>;
}
interface Repository {
  id: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}
interface Snapshot {
  snapshotId: string;
  commitSha: string;
  rootTreeSha: string;
  repository: string;
  ref: string;
  expiresAt: string;
}
interface Entry {
  path: string;
  type: string;
  size: number;
  selectable: boolean;
  reason: string | null;
}
export default function GitHubImport({
  onPreview,
  onClose,
}: {
  onPreview: (preview: GitHubImportPreview) => void;
  onClose?: () => void;
}) {
  const { session } = useAccount();
  const { status, error: statusError } = useGitHubStatus();
  const [repositories, setRepositories] = useState<Repository[]>([]),
    [nextPage, setNextPage] = useState<number | null>(null);
  const [repositoryId, setRepositoryId] = useState(""),
    [ref, setRef] = useState("");
  const [refs, setRefs] = useState<{ name: string; commitSha: string }[]>([]),
    [nextRefPage, setNextRefPage] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [path, setPath] = useState(""),
    [entries, setEntries] = useState<Entry[]>([]);
  const [paths, setPaths] = useState<string[]>([]),
    [folders, setFolders] = useState<string[]>([]),
    [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0),
    mounted = useRef(true),
    locked = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    locked.current = false;
    setBusy(false);
    setRepositories([]);
    setRepositoryId("");
    setRef("");
    setRefs([]);
    setSnapshot(null);
    setEntries([]);
    setPaths([]);
    setFolders([]);
    setAll(false);
  }, [session?.user?.id]);
  async function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
  ) {
    if (locked.current) return;
    locked.current = true;
    const ticket = ++epoch.current;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError("");
    try {
      const value = await work(current.signal);
      if (mounted.current && ticket === epoch.current) accept(value);
    } catch (error) {
      if (
        mounted.current &&
        ticket === epoch.current &&
        !current.signal.aborted
      )
        setError(githubMessage(error));
    } finally {
      if (mounted.current && ticket === epoch.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function loadRepositories(page = 1) {
    void run(
      (signal) =>
        api<{ items: Repository[]; nextPage: number | null }>(
          "/github/repositories?page=" + page,
          { signal },
        ),
      (value) => {
        setRepositories((old) =>
          page === 1 ? value.items : [...old, ...value.items],
        );
        setNextPage(value.nextPage);
      },
    );
  }
  useEffect(() => {
    if (status?.repositoryAccess) loadRepositories();
  }, [status?.repositoryAccess, session?.user?.id]);
  function loadRefs(page = 1) {
    if (!repositoryId) return;
    void run(
      (signal) =>
        api<{
          items: { name: string; commitSha: string }[];
          nextPage: number | null;
        }>(`/github/repositories/${repositoryId}/refs?page=${page}`, {
          signal,
        }),
      (value) => {
        setRefs((old) => (page === 1 ? value.items : [...old, ...value.items]));
        setNextRefPage(value.nextPage);
      },
    );
  }
  function resolve() {
    void run(
      (signal) =>
        api<Snapshot>("/github/snapshots", {
          method: "POST",
          signal,
          body: { repositoryId, ref },
        }),
      (value) => {
        setSnapshot(value);
        setPath("");
        setEntries([]);
        setPaths([]);
        setFolders([]);
        setAll(false);
      },
    );
  }
  function openFolder(value: string) {
    if (!snapshot) return;
    void run(
      (signal) =>
        api<{ entries: Entry[]; complete: boolean }>(
          `/github/snapshots/${snapshot.snapshotId}/tree?path=${encodeURIComponent(value)}`,
          { signal },
        ),
      (result) => {
        if (!result.complete) {
          setError("Дерево неполное; выбор не изменён.");
          return;
        }
        setPath(value);
        setEntries(result.entries);
      },
    );
  }
  useEffect(() => {
    if (snapshot) openFolder("");
  }, [snapshot?.snapshotId]);
  function toggle(entry: Entry, checked: boolean) {
    if (entry.type === "tree") {
      setPaths((old) =>
        old.filter((path) => !path.startsWith(entry.path + "/")),
      );
      setFolders((old) =>
        checked
          ? [
              ...old.filter(
                (path) =>
                  !path.startsWith(entry.path + "/") &&
                  !entry.path.startsWith(path + "/"),
              ),
              entry.path,
            ]
          : old.filter((path) => path !== entry.path),
      );
    } else {
      if (checked)
        setFolders((old) =>
          old.filter((path) => !entry.path.startsWith(path + "/")),
        );
      setPaths((old) =>
        checked
          ? [...old, entry.path]
          : old.filter((path) => path !== entry.path),
      );
    }
  }
  function preview() {
    if (!snapshot) return;
    void run(
      (signal) =>
        api<GitHubImportPreview>("/github/import-previews", {
          method: "POST",
          signal,
          body: {
            snapshotId: snapshot.snapshotId,
            paths: all ? [] : paths,
            folders: all ? [] : folders,
            allText: all,
          },
        }),
      onPreview,
    );
  }
  return (
    <section className="github-import" aria-labelledby="github-import-title">
      <div className="github-actions">
        <h2 id="github-import-title">Импорт из GitHub</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        )}
      </div>
      {!status && !statusError && <p role="status">Проверяем доступ…</p>}
      {status && !status.configured && (
        <p role="status">{status.unavailableReason}</p>
      )}
      {status?.configured && !status.repositoryAccess && (
        <p>
          Привяжите GitHub и отдельно подключите репозитории в{" "}
          <a href="/settings/integrations">настройках интеграций</a>.
        </p>
      )}
      {status?.repositoryAccess && (
        <>
          <label htmlFor="github-repository">Репозиторий</label>
          <Select
            id="github-repository"
            value={repositoryId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setRepositoryId(id);
              setRef(
                repositories.find((repo) => repo.id === id)?.defaultBranch ??
                  "",
              );
              setRefs([]);
              setNextRefPage(null);
              setSnapshot(null);
              setEntries([]);
              setPaths([]);
              setFolders([]);
              setAll(false);
            }}
          >
            <option value="">Выберите репозиторий</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.owner}/{repo.name}
                {repo.private ? " · приватный" : " · публичный"}
              </option>
            ))}
          </Select>
          {nextPage && (
            <button
              type="button"
              disabled={busy}
              onClick={() => loadRepositories(nextPage)}
            >
              Ещё репозитории
            </button>
          )}
          <div className="github-import-grid">
            <div>
              <label htmlFor="github-ref">Ветка, тег или commit SHA</label>
              <input
                id="github-ref"
                maxLength={255}
                value={ref}
                disabled={busy || !repositoryId}
                onChange={(event) => {
                  setRef(event.target.value);
                  setSnapshot(null);
                  setEntries([]);
                }}
              />
            </div>
            <div className="github-actions">
              <button
                type="button"
                disabled={busy || !repositoryId}
                onClick={() => loadRefs()}
              >
                Показать ветки
              </button>
              <button
                type="button"
                disabled={busy || !repositoryId || !ref.trim()}
                onClick={resolve}
              >
                Зафиксировать версию
              </button>
            </div>
          </div>
          {refs.length > 0 && (
            <>
              <label htmlFor="github-branch">Ветки репозитория</label>
              <Select
                id="github-branch"
                value={refs.some((item) => item.name === ref) ? ref : ""}
                disabled={busy}
                onChange={(event) => {
                  setRef(event.target.value);
                  setSnapshot(null);
                  setEntries([]);
                }}
              >
                <option value="">Выберите ветку</option>
                {refs.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </Select>
              {nextRefPage && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => loadRefs(nextRefPage)}
                >
                  Ещё ветки
                </button>
              )}
            </>
          )}
          {snapshot && (
            <>
              <p className="github-commit">Commit: {snapshot.commitSha}</p>
              <label className="github-consent">
                <input
                  type="checkbox"
                  checked={all}
                  disabled={busy}
                  onChange={(event) => {
                    setAll(event.target.checked);
                    setPaths([]);
                    setFolders([]);
                  }}
                />
                Выбрать все текстовые файлы. Бинарные и неподдерживаемые записи
                потребуют отдельного выбора.
              </label>
              <div className="github-actions">
                <span>{path || "Корень"}</span>
                {path && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      openFolder(
                        path.includes("/")
                          ? path.slice(0, path.lastIndexOf("/"))
                          : "",
                      )
                    }
                  >
                    Выше
                  </button>
                )}
              </div>
              <div className="github-tree" aria-label="Файлы GitHub">
                {entries.map((entry) => (
                  <div className="github-tree-row" key={entry.path}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy || all || !entry.selectable}
                        checked={
                          entry.type === "tree"
                            ? folders.includes(entry.path)
                            : paths.includes(entry.path)
                        }
                        onChange={(event) =>
                          toggle(entry, event.target.checked)
                        }
                      />
                      {entry.type === "tree" ? "Папка" : "Файл"}{" "}
                      {entry.path.split("/").pop()}
                    </label>
                    {entry.type === "tree" ? (
                      <button
                        type="button"
                        disabled={busy || !entry.selectable}
                        onClick={() => openFolder(entry.path)}
                      >
                        Открыть
                      </button>
                    ) : (
                      <span className="quiet small">{entry.size} байт</span>
                    )}
                    {entry.reason && (
                      <span className="quiet small">{entry.reason}</span>
                    )}
                  </div>
                ))}
                {!busy && !entries.length && (
                  <p className="quiet">В папке нет записей.</p>
                )}
              </div>
              <p className="quiet small">
                До 100 файлов и папок, всего 1МиБ. Поддерживается строгий UTF-8.
                Исходники попадут в проект после просмотра и подтверждения.
              </p>
              <button
                type="button"
                className="primary"
                disabled={busy || (!all && !paths.length && !folders.length)}
                onClick={preview}
              >
                Просмотреть выбранные исходники
              </button>
            </>
          )}
        </>
      )}
      {busy && <p role="status">Загружаем из GitHub…</p>}
      {(statusError || error) && <p role="alert">{statusError || error}</p>}
    </section>
  );
}
