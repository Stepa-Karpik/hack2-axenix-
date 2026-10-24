import ProjectAccess from "./ProjectAccess";
import { AccountProvider, AccountNav, useAccount } from "./Account";
import AccountAuth from "./AccountAuth";
import ProfilePage from "./ProfilePage";
import SettingsPage from "./SettingsPage";
import FriendsPage from "./FriendsPage";
import SingleRunOutput from "./SingleRunOutput";
import TestProgressView from "./TestProgressView";
import CodeInsights from "./CodeInsights";
import TestCasesEditor from "./TestCasesEditor";
import { parseCases } from "./testCases";
import { readPrepared, writePrepared, clearPrepared } from "./preparedProposal";
import { useProjectList } from "./useProjectList";
import "./projectList.css";
import { testDuration, testReason } from "./testProgress";
import LiveConsole from "./LiveConsole";
import { ThemeToggle } from "./theme";
import Workspace, { useWorkspace } from "./Workspace";
import WorkspaceMenu from "./WorkspaceMenu";
import { activePanels } from "./workspaceLayout";
import {
  FolderOpen,
  House,
  History,
  Settings2,
  Share2,
  MousePointer2,
  Plus,
  PanelsTopLeft,
  Square,
  ChevronDown,
  CircleUserRound,
  Check,
} from "lucide-react";

import Icon from "./Icon";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, projectPath, pollJob } from "./api";
import type {
  Analysis,
  Graph,
  GraphNode,
  Job,
  Project,
  Proposal,
  Report,
  Revision,
  SourceRange,
  SymbolReference,
} from "./types";
import {
  canApply,
  draftKey,
  hasChanges,
  nodeAtOffset,
  nodeOperations,
  operationLabels,
  statementTemplates,
} from "./state";
import type { Draft } from "./state";
import { operationAnchor } from "./state";
import { blockEditPayload, moveTargets, movePositions } from "./blockEdits";
import CodeEditor, { disposeEditorModels } from "./CodeEditor";
import ProjectExplorer, { FileGlyph } from "./ProjectExplorer";
import {
  addPath,
  movePath,
  directoryPaths,
  languageFor,
  methodIdentity,
  matchingMethod,
  remapModels,
  publicJavaType,
} from "./projectFiles";
import type { FileSnapshot } from "./projectFiles";
import FlowCanvas, {
  kindName,
  nodeCaption,
  isIterationProtocol,
} from "./FlowCanvas";
import SymbolInspector from "./SymbolInspector";
import { executionNodes } from "./flowLayout";
import { currentBindings, referenceAt } from "./symbols";
import { sampleSource } from "./sample";
function message(e: unknown) {
  return e instanceof Error ? e.message : "Не удалось выполнить действие";
}
const short = (id?: string | null) => id?.slice(0, 8) ?? "—";
const labelStatus = (s: string) =>
  (
    ({
      queued: "В очереди",
      running: "Выполняется",
      succeeded: "Завершено",
      failed: "Ошибка",
      cancelled: "Отменено",
      matched_on_tests: "Совпало на тестах",
      mismatch: "Найдено расхождение",
      inconclusive: "Недостаточно данных",
      unavailable: "Запуск недоступен",
      compile_error: "Ошибка компиляции",
      valid: "Разобрано",
      invalid: "Ошибка разбора",
    }) as Record<string, string>
  )[s] ?? s;
function editRange(n: GraphNode) {
  const field = n.editableFields[0];
  return (
    n.editableFieldRanges?.[field] ??
    (field === "expression" ? n.sourceRange : null)
  );
}
interface WorkbenchView {
  file: string;
  methodId: string;
  methodIdentity?: ReturnType<typeof methodIdentity>;
  tabs?: string[];
  methodSelections?: Record<string, ReturnType<typeof methodIdentity>>;
}
function readView(id: string): Partial<WorkbenchView> {
  try {
    const view = JSON.parse(
      localStorage.getItem("java-blueprints:view:" + id) ?? "{}",
    );
    return {
      file: typeof view?.file === "string" ? view.file : undefined,
      methodId: typeof view?.methodId === "string" ? view.methodId : undefined,
      methodIdentity: view?.methodIdentity,
      methodSelections: view?.methodSelections,
      tabs: Array.isArray(view?.tabs)
        ? view.tabs.filter((t: unknown) => typeof t === "string")
        : [],
    };
  } catch {
    return {};
  }
}
async function previousGraph(base: string, revision: Revision) {
  let parent = revision.parentRevisionId;
  for (let i = 0; parent && i < 20; i++) {
    const r = await api<Revision>(base + "/revisions/" + parent);
    try {
      const a = await api<Analysis>(base + "/revisions/" + r.id + "/analysis");
      if (a.parseStatus === "valid" && a.graph) return a.graph;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "ANALYSIS_NOT_READY") throw e;
    }
    parent = r.parentRevisionId;
  }
  return null;
}
function filesOf(r: Revision) {
  return Object.fromEntries(r.files.map((f) => [f.path, f.canonicalText]));
}
function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function Brand() {
  return (
    <a
      className="brand"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      <span className="brand-mark">
        <img src="/brand-lockup.png" alt="JB" />
      </span>
      <span>
        Java<span className="brand-light">Blueprints</span>
      </span>
    </a>
  );
}
export default function App() {
  return (
    <AccountProvider>
      <AppRoutes />
    </AccountProvider>
  );
}
function AppRoutes() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const change = () => setPath(location.pathname);
    addEventListener("popstate", change);
    return () => removeEventListener("popstate", change);
  }, []);
  const match = path.match(/^\/projects\/([^/]+)(?:\/runs\/([^/]+))?\/?$/);
  const authModes = [
    "login",
    "register",
    "forgot-password",
    "reset-password",
    "verify-email",
  ] as const;
  const authMode = authModes.find(
    (mode) => path === "/" + mode || path === "/auth/" + mode,
  );
  if (authMode) return <AccountAuth key={authMode} mode={authMode} />;
  if (path === "/settings" || path === "/account") return <SettingsPage />;
  if (path === "/friends") return <FriendsPage />;
  const profile = path.match(/^\/(?:u|profile)\/([^/]+)\/?$/);
  if (profile) {
    let username = profile[1];
    try {
      username = decodeURIComponent(username);
    } catch {}
    return <ProfilePage key={username} username={username} />;
  }
  return match ? (
    <Workbench key={match[1]} projectId={match[1]} runId={match[2]} />
  ) : (
    <Projects />
  );
}
function Projects() {
  const { session } = useAccount();
  const [scope, setScope] = useState<"account" | "legacy">("account");
  const list = useProjectList(
    scope === "legacy" ? "legacy" : undefined,
    session?.user?.id,
  );
  const projects = list.rows,
    loading = list.loading;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function create(sample = false, files?: FileList | null) {
    setBusy(true);
    setError("");
    try {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: {
          name:
            name.trim() ||
            (sample
              ? "Поиск в массиве"
              : files?.[0]?.name.replace(/\.java$/, "") || "Новый проект"),
        },
      });
      if (sample || files?.length) {
        const data = new FormData();
        if (sample)
          data.append(
            "files",
            new File([sampleSource], "Main.java", {
              type: "text/x-java-source",
            }),
          );
        else Array.from(files!).forEach((f) => data.append("files", f, f.name));
        data.append("languageProfileId", "java21-v1");
        await api<Revision>(projectPath(p.id) + "/imports", {
          method: "POST",
          head: null,
          body: data,
        });
      }
      navigate("/projects/" + p.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="projects-page">
      <header className="home-header">
        <Brand />
        <AccountNav />
      </header>
      <main className="project-main">
        <div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <div className="project-heading">
          <h1>
            Ваши проекты<span className="lime-dot">.</span>
          </h1>
          <button
            className="primary"
            onClick={() => input.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" /> Импорт .java
          </button>
        </div>
        {session?.user && (
          <div className="projects-scope" aria-label="Рабочее пространство">
            <button
              aria-pressed={scope === "account"}
              onClick={() => setScope("account")}
            >
              Мои проекты
            </button>
            <button
              aria-pressed={scope === "legacy"}
              onClick={() => setScope("legacy")}
            >
              Локальное пространство
            </button>
            <span className="projects-scope-note">
              {scope === "legacy"
                ? "Прежние проекты этого сервера"
                : "Проекты вашего аккаунта"}
            </span>
          </div>
        )}
        <div className="new-project">
          <label className="sr-only" htmlFor="project-name">
            Название проекта
          </label>
          <input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название нового проекта"
            maxLength={120}
          />
          <button onClick={() => void create()} disabled={busy}>
            Создать проект <Icon name="external" />
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".java"
          multiple
          hidden
          onChange={(e) => void create(false, e.target.files)}
        />
        <div className="project-search">
          <Icon name="search" size={18} />
          <input
            aria-label="Поиск проектов"
            placeholder="Найти проект"
            maxLength={120}
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
          />
          {list.query && (
            <button
              aria-label="Очистить поиск проектов"
              onClick={() => list.setQuery("")}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
        {(error || list.error) && (
          <div className="notice error" role="alert">
            {error || list.error}
            <button onClick={() => (error ? location.reload() : list.retry())}>
              Повторить
            </button>
          </div>
        )}
        <div className="project-list" aria-busy={loading || list.loadingMore}>
          {loading ? (
            <p className="quiet">Загрузка проектов…</p>
          ) : (
            projects.map((p, i) => (
              <button
                className="project-row"
                key={p.id}
                onClick={() => navigate("/projects/" + p.id)}
              >
                <span className="project-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.headRevisionId
                      ? "Версия " + short(p.headRevisionId)
                      : "Нет исходников"}
                  </small>
                </span>
                <span className="quiet small">
                  {new Date(p.updatedAt).toLocaleDateString("ru-RU")}
                </span>
                <span className="arrow">
                  <Icon name="external" size={19} />
                </span>
              </button>
            ))
          )}
          {!loading && !projects.length && !list.error && (
            <p className="quiet">
              {list.query.trim() ? "Ничего не найдено" : "Проектов пока нет"}
            </p>
          )}
        </div>
        {!loading && list.hasMore && (
          <button
            className="projects-more"
            disabled={list.loadingMore}
            onClick={list.loadMore}
          >
            {list.loadingMore ? "Загрузка…" : "Показать ещё"}
          </button>
        )}
        <button
          className="sample-row"
          disabled={busy}
          onClick={() => void create(true)}
        >
          <span className="sample-icon">
            <Icon name="workflow" size={24} />
          </span>
          <span>
            <strong>Начать с примера</strong>
            <small>Main.java · поиск в массиве</small>
          </span>
          <span className="arrow">
            <Icon name="arrow" size={18} />
          </span>
        </button>
      </main>
    </div>
  );
}
function Workbench({
  projectId,
  runId,
}: {
  projectId: string;
  runId?: string;
}) {
  const base = projectPath(projectId);
  const { session: accountSession } = useAccount();
  const [checkingAccess, setCheckingAccess] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  const initialView = useRef(readView(projectId)).current;
  const [project, setProject] = useState<Project | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [historyRows, setHistoryRows] = useState<Revision[]>([]);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [directories, setDirectories] = useState<string[]>([]);
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const [tabs, setTabs] = useState<string[]>(initialView.tabs ?? []);
  const modelIds = useRef<Record<string, string>>({});
  const retiredModelIds = useRef<string[]>([]);
  useEffect(
    () => () => {
      disposeEditorModels([
        ...Object.values(modelIds.current),
        ...retiredModelIds.current,
      ]);
    },
    [],
  );
  function modelId(path: string) {
    return (modelIds.current[path] ??=
      projectId + "/models/" + crypto.randomUUID());
  }
  const selectedMethodIdentity = useRef(initialView.methodIdentity);
  const methodSelections = useRef({
    ...initialView.methodSelections,
    ...(initialView.methodIdentity
      ? { [initialView.methodIdentity.filePath]: initialView.methodIdentity }
      : {}),
  });
  const [importPreview, setImportPreview] = useState<{
    files: { path: string; content: string }[];
    directories: string[];
  } | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const [importChooser, setImportChooser] = useState(false);
  const [createCommand, setCreateCommand] = useState<{
    kind: "file" | "folder";
    id: number;
  }>();
  const [baseId, setBaseId] = useState("");
  const [file, setFile] = useState(initialView.file ?? "");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [methodId, setMethodId] = useState(initialView.methodId ?? "");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [inspectorFocus, setInspectorFocus] = useState(0);
  const [range, setRange] = useState<
    (SourceRange & { diagnosticRevisionId?: string }) | null
  >(null);
  const workspace = useWorkspace(projectId);
  const [showAccess, setShowAccess] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const editorCommands = useRef<{
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
  } | null>(null);
  function setMode(mode: "graph" | "code" | "split") {
    void workspace.revealMany(mode === "split" ? ["graph", "code"] : [mode]);
  }
  function setDock(dock: "output" | "tests" | "changes") {
    workspace.reveal(dock === "output" ? "console" : dock);
  }
  function setInspector(show: boolean) {
    if (show) workspace.reveal("analysis");
    else workspace.hide("analysis");
  }
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Загрузка…");
  const [saving, setSaving] = useState(false);
  const [treeSaving, setTreeSaving] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"run" | "compare" | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const proposalEpoch = useRef(0);
  const restoredProposal = useRef<string | null>(null);
  const [loadingRevision, setLoadingRevision] = useState(true);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const [operation, setOperation] = useState("");
  const [position, setPosition] = useState("");
  const [template, setTemplate] = useState("statement");
  const [statement, setStatement] = useState(statementTemplates.statement);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [movePosition, setMovePosition] = useState("before");
  const [wrapCondition, setWrapCondition] = useState("");
  const [elseSource, setElseSource] = useState("{\n\n}");
  const [intent, setIntent] = useState("semantic_edit");
  const [busy, setBusy] = useState(false);
  const [runnerAvailable, setRunnerAvailable] = useState<boolean | null>(null);
  const [reportId, setReportId] = useState<string | undefined>();
  const importInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Set<AbortController>());
  const filesRef = useRef(files);
  filesRef.current = files;
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const openGeneration = useRef(0);
  const [manualSaveRequired, setManualSaveRequired] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(
        "java-blueprints:view:" + projectId,
        JSON.stringify({
          file,
          methodId,
          tabs,
          methodSelections: methodSelections.current,
          methodIdentity:
            methodIdentity(graph?.methods.find((m) => m.id === methodId)) ??
            selectedMethodIdentity.current,
        }),
      );
    } catch {}
  }, [projectId, file, methodId, tabs]);
  useEffect(() => {
    if (file && Object.hasOwn(files, file))
      setTabs((old) => (old.includes(file) ? old : [...old, file]));
  }, [file, files]);
  useEffect(() => {
    const m = graph?.methods.find((m) => m.id === methodId);
    if (m) {
      selectedMethodIdentity.current = methodIdentity(m);
      methodSelections.current[m.sourceRange.filePath] = methodIdentity(m);
    }
  }, [graph, methodId]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const dirty = revision
    ? hasChanges(files, filesOf(revision)) ||
      JSON.stringify(directoryPaths(files, directories)) !==
        JSON.stringify(
          directoryPaths(filesOf(revision), revision.directories ?? []),
        )
    : Object.keys(files).length > 0 || directories.length > 0;
  const historical = !!revision && revision.id !== project?.headRevisionId;
  const accessReadOnly = project?.canEdit === false || checkingAccess;
  const readOnly = historical || accessReadOnly;
  useEffect(() => {
    if (accessReadOnly) {
      saveController.current?.abort();
      setDialog(null);
    }
  }, [accessReadOnly]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const recheck = () => {
      setCheckingAccess(true);
      saveController.current?.abort();
      api<Project>(base, { signal: controller.signal })
        .then((next) => {
          // Capability refresh must not turn an open editing base into history.
          // Concurrent saves use the existing revision-conflict recovery flow.
          if (active)
            setProject((current) =>
              current?.id === next.id
                ? { ...next, headRevisionId: current.headRevisionId }
                : next,
            );
        })
        .catch((e) => {
          if (active && e.name !== "AbortError") {
            setProject((current) =>
              current ? { ...current, canEdit: false } : current,
            );
            setError(
              "Доступ изменился. Локальный черновик сохранён в браузере. " +
                message(e),
            );
          }
        })
        .finally(() => {
          if (active) setCheckingAccess(false);
        });
    };
    recheck();
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("focus", recheck);
    };
  }, [base, accountSession?.user?.id]);
  const [analyzing, setAnalyzing] = useState(false);
  const activeFileRef = useRef(file);
  activeFileRef.current = file;
  const stale =
    !!graph &&
    (dirty ||
      graph.revisionId !== revision?.id ||
      analysis?.parseStatus !== "valid");
  const track = useCallback(
    async (j: Job, onProgress?: (j: Job) => void) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        return await pollJob(
          () => api<Job>(`${base}/jobs/${j.id}`, { signal: controller.signal }),
          controller.signal,
          onProgress,
        );
      } finally {
        controllers.current.delete(controller);
      }
    },
    [base],
  );
  const analyze = useCallback(
    async (r: Revision) => {
      const current = ++generation.current;
      setAnalyzing(true);
      if (!r.files.some((f) => f.path.endsWith(".java"))) {
        setAnalysis(null);
        setGraph(null);
        setMethodId("");
        setSelected(null);
        setRange(null);
        setAnalyzing(false);
        setStatus("Сохранено · нет Java-исходников");
        return;
      }
      setStatus("Разбор…");
      try {
        let a: Analysis;
        try {
          a = await api<Analysis>(`${base}/revisions/${r.id}/analysis`);
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== "ANALYSIS_NOT_READY")
            throw e;
          const capability = await api<Project>(base);
          if (capability.canEdit === false)
            throw new Error(
              "Граф ещё не подготовлен владельцем проекта. Исходный код доступен для просмотра.",
            );
          const j = await api<Job>(`${base}/revisions/${r.id}/analysis`, {
            method: "POST",
            body: {},
          });
          const final = await track(j);
          if (final.status !== "succeeded")
            throw new Error(final.error?.message ?? "Разбор не завершён");
          a = await api<Analysis>(`${base}/revisions/${r.id}/analysis`);
        }
        if (!mounted.current || current !== generation.current) return;
        setAnalysis(a);
        if (a.graph && a.parseStatus === "valid") {
          setGraph(a.graph);
          setSelected(null);
          setRange(null);
          setMethodId(
            matchingMethod(
              a.graph.methods,
              methodSelections.current[activeFileRef.current] ??
                (selectedMethodIdentity.current?.filePath ===
                activeFileRef.current
                  ? selectedMethodIdentity.current
                  : undefined),
            )?.id ??
              a.graph.methods.find(
                (m) => m.sourceRange.filePath === activeFileRef.current,
              )?.id ??
              (activeFileRef.current.endsWith(".java")
                ? ""
                : a.graph.methods[0]?.id) ??
              "",
          );
        } else if (!graphRef.current) {
          const previous = await previousGraph(base, r);
          if (previous && mounted.current && current === generation.current) {
            setGraph(previous);
            setMethodId((old) =>
              previous.methods.some((m) => m.id === old)
                ? old
                : (previous.methods[0]?.id ?? ""),
            );
          }
        }
        setStatus(
          a.parseStatus === "valid"
            ? "Сохранено"
            : "Исходник сохранён · ошибка разбора",
        );
      } catch (e) {
        if (mounted.current && current === generation.current) {
          setError(message(e));
          setStatus("Разбор недоступен");
        }
      } finally {
        if (mounted.current && current === generation.current)
          setAnalyzing(false);
      }
    },
    [base, track],
  );
  const refreshHistory = useCallback(
    () => api<Revision[]>(base + "/revisions?limit=100").then(setHistoryRows),
    [base],
  );
  async function openRevision(id: string, restore = false) {
    proposalEpoch.current++;
    setProposal(null);
    setReferenceId(null);
    setRange(null);
    const openId = ++openGeneration.current;
    setLoadingRevision(true);
    try {
      const r = await api<Revision>(base + "/revisions/" + id);
      if (!mounted.current || openId !== openGeneration.current) return;
      setManualSaveRequired(false);
      setRevision(r);
      setBaseId(r.id);
      let text = filesOf(r);
      let dirs = r.directories ?? [];
      if (restore) {
        try {
          const raw = localStorage.getItem(draftKey(projectId));
          if (raw) {
            const draft = JSON.parse(raw) as Draft;
            if (draft.files && typeof draft.baseRevisionId === "string") {
              text = Object.fromEntries(
                Object.entries(draft.files).map(([path, content]) => [
                  path,
                  content.replace(/\r\n?/g, "\n"),
                ]),
              );
              dirs = draft.directories ?? [];
              setBaseId(draft.baseRevisionId);
              if (draft.baseRevisionId !== r.id) {
                setConflict(true);
                setError(
                  "Есть локальная правка другой версии. Она сохранена; выберите основу перед сохранением.",
                );
              }
            }
          }
        } catch {
          setError("Не удалось восстановить локальный черновик");
        }
      }
      setFiles(text);
      setDirectories(dirs);
      setTabs((old) => old.filter((p) => Object.hasOwn(text, p)));
      setFile((old) => (old in text ? old : (Object.keys(text)[0] ?? "")));
      setSelected(null);
      setRange(null);
      void analyze(r);
    } catch (e) {
      if (mounted.current && openId === openGeneration.current)
        setError(message(e));
    } finally {
      if (mounted.current && openId === openGeneration.current)
        setLoadingRevision(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    Promise.all([
      api<Project>(base),
      refreshHistory(),
      api<{ runner: { available: boolean } }>("/capabilities"),
    ])
      .then(([p, , c]) => {
        if (!mounted.current) return;
        setProject(p);
        setRunnerAvailable(c.runner.available);
        if (p.headRevisionId) void openRevision(p.headRevisionId, true);
        else {
          setStatus("Добавьте исходники");
          setLoadingRevision(false);
        }
      })
      .catch((e) => {
        setError(message(e));
        setLoadingRevision(false);
      });
    return () => {
      mounted.current = false;
      generation.current++;
      controllers.current.forEach((c) => c.abort());
      saveController.current?.abort();
    };
  }, [projectId]);
  useEffect(() => {
    if ((!revision && !dirty) || (readOnly && !dirty)) return;
    try {
      if (dirty)
        localStorage.setItem(
          draftKey(projectId),
          JSON.stringify({ baseRevisionId: baseId, files, directories }),
        );
      else if (!conflict) localStorage.removeItem(draftKey(projectId));
    } catch {
      setError("Локальное хранилище недоступно. Сохраните исходник на сервер.");
    }
  }, [
    files,
    directories,
    baseId,
    revision,
    projectId,
    dirty,
    readOnly,
    conflict,
  ]);
  const save = useCallback(async () => {
    if (
      savingRef.current ||
      !project ||
      conflict ||
      readOnly ||
      busy ||
      loadingRevision
    )
      return false;
    const snapshot = filesRef.current;
    if (
      revision &&
      !hasChanges(snapshot, filesOf(revision)) &&
      JSON.stringify(directoryPaths(snapshot, directoriesRef.current)) ===
        JSON.stringify(
          directoryPaths(filesOf(revision), revision.directories ?? []),
        )
    )
      return true;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const controller = new AbortController();
    saveController.current = controller;
    try {
      const r = await api<Revision>(base + "/revisions", {
        signal: controller.signal,
        method: "POST",
        head: baseId || null,
        body: {
          files: Object.entries(snapshot).map(([path, content]) => ({
            path,
            content,
          })),
          directories: directoriesRef.current,
          intent: "semantic_edit",
          expectedHeadRevisionId: baseId || "empty",
        },
      });
      if (!mounted.current || controller.signal.aborted) return false;
      setRevision(r);
      setBaseId(r.id);
      setProject((p) =>
        p
          ? {
              ...p,
              headRevisionId: r.id,
              originalRevisionId: p.originalRevisionId ?? r.id,
            }
          : p,
      );
      setStatus("Сохранено");
      setManualSaveRequired(false);
      void refreshHistory();
      void analyze(r);
      return true;
    } catch (e) {
      if (controller.signal.aborted) return false;
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        setConflict(true);
        setError(
          "Версия изменилась в другом окне. Локальная правка сохранена.",
        );
      } else setError(message(e));
      return false;
    } finally {
      if (saveController.current === controller) saveController.current = null;
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    project,
    conflict,
    readOnly,
    busy,
    loadingRevision,
    revision,
    base,
    baseId,
    refreshHistory,
    analyze,
  ]);
  useEffect(() => {
    if (!dirty || conflict || readOnly || !revision || manualSaveRequired)
      return;
    // Local drafts persist on every edit; publish after a longer idle pause.
    const timer = setTimeout(() => void save(), 8000);
    return () => clearTimeout(timer);
  }, [
    files,
    directories,
    dirty,
    conflict,
    readOnly,
    revision,
    save,
    manualSaveRequired,
  ]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !accessReadOnly) {
        e.preventDefault();
        const kind = e.shiftKey ? "compare" : "run";
        if (dirty)
          void save().then((ok) => {
            if (ok) setDialog(kind);
          });
        else setDialog(kind);
      }
      if (e.key === "Escape") {
        setDialog(null);
        workspace.setMaximized(null);
      }
    };
    // Capture Save before Monaco handles it and stops the event bubbling.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [save, dirty, accessReadOnly]);
  useEffect(() => {
    setReportId(undefined);
    if (!runId) {
      setJob(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    api<Job>(base + "/runs/" + runId, { signal: controller.signal })
      .then((j) =>
        pollJob(
          () =>
            api<Job>(base + "/runs/" + runId, { signal: controller.signal }),
          controller.signal,
          (current) => {
            if (active) {
              setJob(current);
              if (current.result?.comparisonId) {
                setReportId(current.result.comparisonId);
              }
            }
          },
        ),
      )
      .catch((e) => {
        if (active && e.name !== "AbortError") setError(message(e));
      });
    return () => {
      active = false;
      controller.abort();
      controllers.current.delete(controller);
    };
  }, [runId, base]);
  const bindingsActive =
    currentBindings(analysis, revision?.id, dirty) && !loadingRevision;
  const references = analysis?.semantics?.references ?? [];
  const activeReference = bindingsActive
    ? references.find((r) => r.id === referenceId)
    : undefined;
  function pickReference(reference: SymbolReference) {
    if (!bindingsActive || busy || saving || loadingRevision) return;
    setReferenceId(reference.id);
    setFile(reference.sourceRange.filePath);
    setRange(reference.sourceRange);
    setMode("split");
  }
  function jumpDeclaration(target: SourceRange) {
    if (
      !bindingsActive ||
      busy ||
      saving ||
      loadingRevision ||
      !Object.hasOwn(files, target.filePath)
    )
      return;
    setFile(target.filePath);
    setRange(target);
    setSelected(null);
    const enclosing = graph?.methods.find(
      (m) =>
        m.sourceRange.filePath === target.filePath &&
        m.sourceRange.startOffset <= target.startOffset &&
        target.endOffset <= m.sourceRange.endOffset,
    );
    setMethodId(enclosing?.id ?? "");
    setMode("split");
  }
  function pickNode(n: GraphNode) {
    if (stale || busy || saving || loadingRevision) return;
    setInspectorFocus((value) => value + 1);
    setSelected(n);
    setReferenceId(
      bindingsActive && n.sourceRange
        ? (references.find(
            (r) =>
              r.sourceRange.filePath === n.sourceRange!.filePath &&
              r.sourceRange.startOffset >= n.sourceRange!.startOffset &&
              r.sourceRange.endOffset <= n.sourceRange!.endOffset,
          )?.id ?? null)
        : null,
    );
    const bound = editRange(n);
    setRange(bound ?? n.sourceRange);
    if (n.sourceRange) setFile(n.sourceRange.filePath);
    setInspector(true);
    setExpression(
      bound
        ? (files[bound.filePath] ?? "").slice(
            bound.startOffset,
            bound.endOffset,
          )
        : "",
    );
  }
  function edit(text: string) {
    if (readOnly || filesRef.current[file] === text) return;
    proposalEpoch.current++;
    const next = { ...filesRef.current, [file]: text };
    filesRef.current = next;
    setFiles(next);
    setStatus("Есть изменения");
    setProposal(null);
    setReferenceId(null);
    setRange(null);
  }
  function offset(value: number) {
    if (bindingsActive && !busy && !saving && !loadingRevision) {
      const reference = referenceAt(references, file, value);
      setReferenceId(reference?.id ?? null);
    }
    if (!graph || stale || busy || saving || loadingRevision) return;
    const n = nodeAtOffset(graph.nodes, file, value);
    if (n) {
      setSelected(n);
      setMethodId(n.methodId);
      const bound = editRange(n);
      setExpression(
        bound
          ? (files[bound.filePath] ?? "").slice(
              bound.startOffset,
              bound.endOffset,
            )
          : "",
      );
    }
  }
  async function importFiles(list: FileList | null) {
    if (readOnly) return;
    if (!list?.length || !project) return;
    setBusy(true);
    setError("");
    setImportChooser(false);
    try {
      const data = new FormData();
      Array.from(list).forEach((f) =>
        data.append("files", f, f.webkitRelativePath || f.name),
      );
      const preview = await api<{
        files: { path: string; content: string }[];
        directories: string[];
      }>(base + "/import-previews", { method: "POST", body: data });
      setImportPreview(preview);
      setImportSelected([
        ...preview.files.map((f) => f.path),
        ...preview.directories,
      ]);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  }
  async function persistSnapshot(
    snapshot: FileSnapshot,
    importedPaths?: string[],
    accepted?: () => void,
    importedDirectories?: string[],
  ) {
    if (savingRef.current || busy || readOnly || conflict || loadingRevision)
      throw new Error(
        "Дождитесь завершения действия или разрешите конфликт версий.",
      );
    if (
      revision &&
      !hasChanges(snapshot.files, filesOf(revision)) &&
      JSON.stringify(directoryPaths(snapshot.files, snapshot.directories)) ===
        JSON.stringify(
          directoryPaths(filesOf(revision), revision.directories ?? []),
        )
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setTreeSaving(true);
    setError("");
    try {
      const r = await api<Revision>(base + "/revisions", {
        method: "POST",
        head: baseId || null,
        body: {
          files: Object.entries(snapshot.files).map(([path, content]) => ({
            path,
            content,
          })),
          directories: snapshot.directories,
          importedPaths,
          importedDirectories,
          intent: "semantic_edit",
          expectedHeadRevisionId: baseId || "empty",
        },
      });
      if (!mounted.current) return;
      accepted?.();
      setFiles(filesOf(r));
      setDirectories(r.directories ?? []);
      setRevision(r);
      setBaseId(r.id);
      setProject((p) =>
        p
          ? {
              ...p,
              headRevisionId: r.id,
              originalRevisionId: p.originalRevisionId ?? r.id,
            }
          : p,
      );
      setProposal(null);
      setSelected(null);
      setReferenceId(null);
      setRange(null);
      setStatus("Сохранено");
      void refreshHistory();
      void analyze(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        setConflict(true);
        setError(
          "Версия изменилась. Локальные изменения сохранены; выберите актуальную основу.",
        );
      }
      throw e;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setTreeSaving(false);
    }
  }
  async function changePath(
    kind: "file" | "folder" | "move" | "delete",
    from: string,
    to: string,
  ) {
    const snapshot = {
      files: filesRef.current,
      directories: directoriesRef.current,
    };
    const affected = (path: string) =>
      path === from || path.startsWith(from + "/");
    if (
      kind === "delete" &&
      !Object.hasOwn(snapshot.files, from) &&
      !directoryPaths(snapshot.files, snapshot.directories).includes(from)
    )
      throw new Error("Файл или папка больше не существует.");
    const next =
      kind === "delete"
        ? {
            files: Object.fromEntries(
              Object.entries(snapshot.files).filter(
                ([path]) => !affected(path),
              ),
            ),
            // Preserve parents made empty by deleting their last file.
            directories: directoryPaths(
              snapshot.files,
              snapshot.directories,
            ).filter((path) => !affected(path)),
          }
        : kind === "move"
          ? movePath(snapshot, from, to)
          : addPath(snapshot, to, kind === "folder");
    const identity = selectedMethodIdentity.current;
    const selections = methodSelections.current;
    const mapped = (p: string) =>
      p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p;
    if (kind === "move") {
      if (identity)
        selectedMethodIdentity.current = {
          ...identity,
          filePath: mapped(identity.filePath),
        };
      methodSelections.current = Object.fromEntries(
        Object.entries(selections).map(([path, choice]) => [
          mapped(path),
          choice ? { ...choice, filePath: mapped(choice.filePath) } : choice,
        ]),
      );
    }
    try {
      await persistSnapshot(next, undefined, () => {
        if (kind === "move") {
          modelIds.current = remapModels(modelIds.current, from, to);
          setTabs((old) => old.map(mapped));
          setFile((old) => mapped(old));
        } else if (kind === "delete") {
          setTabs((old) => old.filter((path) => !affected(path)));
          setFile((old) =>
            affected(old) ? (Object.keys(next.files)[0] ?? "") : old,
          );
          methodSelections.current = Object.fromEntries(
            Object.entries(selections).filter(([path]) => !affected(path)),
          );
          if (identity && affected(identity.filePath))
            selectedMethodIdentity.current = undefined;
          // Recreating a deleted path must not reuse its old undo model.
          retiredModelIds.current.push(
            ...Object.entries(modelIds.current)
              .filter(([path]) => affected(path))
              .map(([, id]) => id),
          );
          modelIds.current = Object.fromEntries(
            Object.entries(modelIds.current).filter(
              ([path]) => !affected(path),
            ),
          );
        } else if (kind === "file") setFile(to);
      });
    } catch (e) {
      selectedMethodIdentity.current = identity;
      methodSelections.current = selections;
      throw e;
    }
  }
  async function applyImport() {
    if (!importPreview) return;
    try {
      let next = {
        files: filesRef.current,
        directories: directoriesRef.current,
      };
      const incoming = importPreview.files.filter((f) =>
        importSelected.includes(f.path),
      );
      for (const f of incoming) {
        next = addPath(next, f.path, false);
        next.files[f.path] = f.content;
      }
      const dirs = importPreview.directories.filter((p) =>
        importSelected.includes(p),
      );
      for (const p of dirs) {
        if (
          p in next.files ||
          Object.keys(next.files).some((f) => p.startsWith(f + "/"))
        )
          throw new Error("Путь папки занят файлом: " + p);
      }
      next.directories = directoryPaths(next.files, [
        ...next.directories,
        ...dirs,
      ]);
      await persistSnapshot(
        next,
        incoming.map((f) => f.path),
        undefined,
        dirs,
      );
      setImportPreview(null);
      if (incoming[0]) setFile(incoming[0].path);
    } catch (e) {
      setError(message(e));
    }
  }
  const [dropEdit, setDropEdit] = useState<{
    nodeId: string;
    kind: string;
    position: string;
    serial: number;
  } | null>(null);
  const operations = nodeOperations(selected);
  const positions = selected?.insertionPositions ?? [];
  const targets = moveTargets(selected, graph);
  const target = targets.find((n) => n.id === targetNodeId);
  const moveOptions =
    selected && target && graph ? movePositions(selected, target, graph) : [];
  const [optimizationEdit, setOptimizationEdit] = useState<{
    nodeId: string;
    serial: number;
  } | null>(null);
  const handledOptimization = useRef<number | null>(null);
  const changePayload = blockEditPayload(selected, graph, operation, {
    position,
    statement,
    expression,
    condition: wrapCondition,
    elseSource,
    targetNodeId,
    movePosition,
  });
  useEffect(() => {
    proposalEpoch.current++;
    setOperation(nodeOperations(selected)[0] ?? "");
    setPosition(selected?.insertionPositions?.[0] ?? "");
    setTemplate("statement");
    setStatement(
      selected?.allowedOperations?.includes("replace_statement") &&
        selected.sourceRange
        ? (filesRef.current[selected.sourceRange.filePath] ?? "").slice(
            selected.sourceRange.startOffset,
            selected.sourceRange.endOffset,
          )
        : statementTemplates.statement,
    );
    setIntent("semantic_edit");
    setTargetNodeId("");
    setMovePosition("before");
    setWrapCondition("");
    setElseSource("{\n\n}");
    setProposal(null);
    if (dropEdit && dropEdit.nodeId === selected?.id) {
      setOperation("insert_statement");
      setTemplate(dropEdit.kind);
      setStatement(statementTemplates[dropEdit.kind]);
      setPosition(dropEdit.position);
    }
    if (
      optimizationEdit &&
      optimizationEdit.serial !== handledOptimization.current &&
      optimizationEdit.nodeId === selected?.id &&
      selected?.allowedOperations?.includes("optimize_membership")
    ) {
      setOperation("optimize_membership");
      setIntent("preserve_behavior");
      handledOptimization.current = optimizationEdit.serial;
    }
  }, [selected?.id, revision?.id, dropEdit?.serial, optimizationEdit?.serial]);
  useEffect(() => {
    proposalEpoch.current++;
    setProposal(null);
  }, [
    operation,
    position,
    statement,
    expression,
    intent,
    targetNodeId,
    movePosition,
    wrapCondition,
    elseSource,
  ]);
  useEffect(() => {
    if (
      loadingRevision ||
      analyzing ||
      dirty ||
      readOnly ||
      conflict ||
      !revision ||
      !project?.headRevisionId ||
      proposal ||
      busy
    )
      return;
    const id = readPrepared(projectId);
    if (!id || restoredProposal.current === id) return;
    restoredProposal.current = id;
    const epoch = proposalEpoch.current,
      opened = openGeneration.current;
    const headId = project.headRevisionId;
    const controller = new AbortController();
    controllers.current.add(controller);
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      epoch === proposalEpoch.current &&
      opened === openGeneration.current;
    void (async () => {
      let p = await api<Proposal>(base + "/changes/" + id, {
        signal: controller.signal,
      });
      if (!current()) return;
      if (
        p.baseRevisionId !== headId ||
        !["queued", "running", "ready"].includes(p.status)
      ) {
        clearPrepared(projectId, id);
        return;
      }
      if (p.status !== "ready") {
        await pollJob(
          () =>
            api<Job>(base + "/jobs/" + p.jobId, { signal: controller.signal }),
          controller.signal,
        );
        if (!current()) return;
        p = await api<Proposal>(base + "/changes/" + id, {
          signal: controller.signal,
        });
      }
      if (!current()) return;
      if (
        p.baseRevisionId !== headId ||
        p.status !== "ready" ||
        !p.candidateRevisionId
      ) {
        clearPrepared(projectId, id);
        return;
      }
      const candidateRevision = await api<Revision>(
        base + "/revisions/" + p.candidateRevisionId,
        { signal: controller.signal },
      );
      if (!current()) return;
      setHistoryRows((rows) =>
        rows.some((r) => r.id === candidateRevision.id)
          ? rows
          : [candidateRevision, ...rows],
      );
      setProposal(p);
    })()
      .catch((e) => {
        if (!current() || e.name === "AbortError") return;
        if (e instanceof ApiError && e.status === 404)
          clearPrepared(projectId, id);
        else setError("Не удалось восстановить изменение: " + message(e));
      })
      .finally(() => controllers.current.delete(controller));
    return () => {
      controller.abort();
      controllers.current.delete(controller);
    };
  }, [
    base,
    projectId,
    project?.headRevisionId,
    revision?.id,
    loadingRevision,
    analyzing,
    dirty,
    readOnly,
    conflict,
    busy,
  ]);
  const inFlight =
    busy ||
    saving ||
    loadingRevision ||
    !!dialog ||
    (!!job && ["queued", "running"].includes(job.status));
  async function restoreRevision(sourceId: string) {
    if (
      accessReadOnly ||
      !project?.headRevisionId ||
      sourceId === project.headRevisionId ||
      inFlight
    )
      return;
    if (dirty || conflict) {
      setError("Сначала сохраните локальную правку. Черновик сохранён.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<Revision>(`${base}/revisions/${sourceId}/restore`, {
        method: "POST",
        head: project.headRevisionId,
        body: { expectedHeadRevisionId: project.headRevisionId },
      });
      setProject({ ...project, headRevisionId: r.id });
      setReportId(undefined);
      await openRevision(r.id);
      await refreshHistory();
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT")
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (
      !selected ||
      !analysis ||
      !revision ||
      stale ||
      readOnly ||
      inFlight ||
      !operations.includes(operation) ||
      !changePayload
    )
      return;
    setBusy(true);
    setError("");
    const epoch = ++proposalEpoch.current;
    try {
      const p = await api<Proposal>(base + "/changes", {
        method: "POST",
        body: {
          baseRevisionId: revision.id,
          analysisId: analysis.id,
          methodId: selected.methodId,
          nodeId: selected.id,
          operation,
          payload: changePayload,
          intent:
            operation === "optimize_membership" ? "preserve_behavior" : intent,
        },
      });
      if (!mounted.current || epoch !== proposalEpoch.current) return;
      writePrepared(projectId, p.id);
      restoredProposal.current = p.id;
      setProposal(p);
      setDock("changes");
      const final = await track({
        id: p.jobId,
        status: "queued",
        type: "change",
      });
      const ready = await api<Proposal>(base + "/changes/" + p.id);
      if (!mounted.current || epoch !== proposalEpoch.current) return;
      setProposal(ready);
      void refreshHistory();
      if (final.status === "failed")
        setError(final.error?.message ?? "Кандидат отклонён");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (
      !proposal ||
      !project ||
      inFlight ||
      dirty ||
      readOnly ||
      conflict ||
      !canApply(
        proposal.status,
        proposal.baseRevisionId,
        project.headRevisionId,
        proposal.intent,
        exactMatched,
      )
    )
      return;
    setBusy(true);
    try {
      const p = await api<Project>(base + "/head", {
        method: "POST",
        head: project.headRevisionId,
        body: {
          candidateRevisionId: proposal.candidateRevisionId,
          proposalId: proposal.id,
          expectedHeadRevisionId: project.headRevisionId,
          ...(proposal.intent === "preserve_behavior"
            ? { verificationReportId: reportId }
            : {}),
        },
      });
      setProject(p);
      clearPrepared(projectId, proposal.id);
      setProposal({ ...proposal, status: "applied" });
      await openRevision(p.headRevisionId!);
      void refreshHistory();
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT")
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function exportRevision(paths?: string[]) {
    if (!revision) return;
    setBusy(true);
    try {
      const result = await api<{ downloadUrl: string }>(base + "/exports", {
        method: "POST",
        body: {
          revisionId: revision.id,
          paths,
          includeReportIds: reportId ? [reportId] : [],
        },
      });
      const a = document.createElement("a");
      a.href = result.downloadUrl;
      a.download = project?.name + ".zip";
      a.click();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function rebase() {
    try {
      const p = await api<Project>(base);
      setProject(p);
      if (p.headRevisionId) {
        const r = await api<Revision>(base + "/revisions/" + p.headRevisionId);
        setRevision(r);
        setBaseId(r.id);
        setConflict(false);
        setManualSaveRequired(true);
        setDock("changes");
        setError(
          "Локальный текст сохранён поверх выбранной основы. Проверьте изменения и нажмите «Сохранить».",
        );
        void analyze(r);
      }
    } catch (e) {
      setError(message(e));
    }
  }
  function downloadDraft() {
    const a = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([files[file] ?? ""], { type: "text/plain" }),
    );
    a.href = url;
    a.download = file.split("/").pop() ?? "Main.java";
    a.click();
    URL.revokeObjectURL(url);
  }
  const report = job?.result?.report;
  const exactMatched =
    !!proposal &&
    report?.outcome === "matched_on_tests" &&
    report.baseRevisionId === proposal.baseRevisionId &&
    report.candidateRevisionId === proposal.candidateRevisionId;
  const method = graph?.methods.find((m) => m.id === methodId);
  const expressions =
    graph?.nodes.filter((n) => n.methodId === methodId && !!editRange(n)) ?? [];
  const symbolPanel = (
    <SymbolInspector
      semantics={analysis?.semantics}
      active={bindingsActive && !busy && !saving}
      selected={activeReference}
      file={file}
      scope={
        selected?.sourceRange?.filePath === file
          ? selected.sourceRange
          : method?.sourceRange?.filePath === file
            ? method.sourceRange
            : null
      }
      files={files}
      onSelect={pickReference}
      onJump={jumpDeclaration}
    />
  );
  const methodExecutionNodes = graph
    ? executionNodes(
        graph.nodes.filter((n) => n.methodId === methodId),
        graph.edges,
      )
    : [];
  const methodNodeIds = new Set(methodExecutionNodes.map((n) => n.id));
  const panels = {
    project: (
      <aside className="sidebar">
        <div className="project-root">
          <FolderOpen size={16} />
          <span>{project?.name ?? "Проект"}</span>
        </div>
        <ProjectExplorer
          snapshot={{ files, directories }}
          active={file}
          search={search}
          methods={graph?.methods ?? []}
          methodsDisabled={stale || analyzing}
          methodId={methodId}
          disabled={inFlight || conflict || (!!file && !editorReady)}
          readOnly={readOnly}
          onOpen={(p) => {
            setMethodId(
              matchingMethod(graph?.methods ?? [], methodSelections.current[p])
                ?.id ??
                graph?.methods.find((m) => m.sourceRange.filePath === p)?.id ??
                "",
            );
            setFile(p);
            workspace.reveal("code");
            setRange(null);
            setReferenceId(null);
          }}
          onMethod={(m) => {
            if (stale) return;
            setMethodId(m.id);
            selectedMethodIdentity.current = methodIdentity(m);
            methodSelections.current[m.sourceRange.filePath] =
              methodIdentity(m);
            setFile(m.sourceRange.filePath);
            setRange(m.sourceRange);
            setSelected(null);
            setReferenceId(null);
            workspace.reveal("graph");
          }}
          onChange={changePath}
          onImport={() => setImportChooser(true)}
          onDownload={(p) => void exportRevision([p])}
          createCommand={createCommand}
        />
        <details className="sidebar-bottom" id="project-history">
          <summary className="panel-caption">
            ИСТОРИЯ{" "}
            <button
              title="Обновить историю"
              aria-label="Обновить историю"
              onClick={() => void refreshHistory()}
            >
              <Icon name="refresh" size={14} />
            </button>
          </summary>
          <div className="revision-list">
            {historyRows.map((r, i) => (
              <div className="revision-row" key={r.id}>
                <button
                  disabled={inFlight}
                  className={revision?.id === r.id ? "current" : ""}
                  onClick={() => {
                    if (dirty) {
                      setError(
                        "Локальная правка сохранена. Сначала сохраните её на сервер или скачайте черновик.",
                      );
                      return;
                    }
                    void openRevision(r.id);
                  }}
                >
                  <span className="revision-dot" />
                  <span>
                    {short(r.id)}{" "}
                    <small>
                      {r.id === project?.originalRevisionId
                        ? "Исходная"
                        : r.origin === "restore"
                          ? "Восстановлена"
                          : r.origin === "candidate"
                            ? "Кандидат"
                            : i === 0
                              ? "Последняя"
                              : new Date(r.createdAt).toLocaleTimeString(
                                  "ru-RU",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                    </small>
                  </span>
                </button>
                {r.id !== project?.headRevisionId && (
                  <button
                    className="restore-revision"
                    aria-label={"Восстановить версию " + short(r.id)}
                    title={
                      dirty || conflict
                        ? "Сначала сохраните локальную правку"
                        : "Восстановить как новую версию"
                    }
                    disabled={accessReadOnly || inFlight || dirty || conflict}
                    onClick={() => void restoreRevision(r.id)}
                  >
                    Восстановить
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
        <div className="local-label" role="status" aria-live="polite">
          <span className={"connection-dot " + (dirty ? "unsaved" : "")} />
          {saving ? "Сохранение…" : dirty ? "Есть локальные изменения" : status}
        </div>
      </aside>
    ),
    palette: (
      <div className="block-palette">
        <p className="small quiet">Перетащите на схему: выше или ниже шага.</p>
        {(["statement", "condition", "loop"] as const).map((kind) => (
          <button
            key={kind}
            className={"palette-block palette-" + kind}
            draggable={!stale && !readOnly && !inFlight}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-blueprint-block", kind);
              e.dataTransfer.effectAllowed = "copy";
            }}
            disabled={stale || readOnly || inFlight}
            onClick={() => {
              if (!selected || !operations.includes("insert_statement")) {
                setStatus("Перетащите блок на шаг схемы");
                return;
              }
              setOperation("insert_statement");
              setTemplate(kind);
              setStatement(statementTemplates[kind]);
              if (!positions.includes(position))
                setPosition(positions[0] ?? "after");
              workspace.reveal("analysis");
            }}
          >
            <span aria-hidden="true">
              {kind === "condition" ? "◇" : kind === "loop" ? "↻" : "▭"}
            </span>
            {
              { statement: "Оператор", condition: "Условие", loop: "Цикл" }[
                kind
              ]
            }
          </button>
        ))}
        <p className="small quiet">
          {!selected
            ? "Выберите узел схемы для вставки."
            : !operations.includes("insert_statement")
              ? "У этого узла нет точки вставки."
              : "Шаблон откроется в инспекторе. Изменение проходит проверку и diff."}
        </p>
      </div>
    ),
    graph: (
      <section className="graph-pane" aria-label="Схема метода">
        <div className="editor-caption">
          <span>СХЕМА МЕТОДА</span>
          <span>{method ? method.signature : "Выберите метод"}</span>
          {graph && (
            <span title={graph.revisionId}>
              Версия {short(graph.revisionId)}
              {stale ? " · схема сохранённого кода" : " · актуальная схема"}
            </span>
          )}
        </div>
        {graph && stale && (
          <p className="small quiet" role="status">
            {dirty
              ? "Редактор содержит локальный черновик. Схема показывает сохранённую версию; Ctrl+S сохранит код и обновит схему."
              : "Схема относится к предыдущей сохранённой версии; обновление ещё не завершено."}
          </p>
        )}
        {graph && methodId ? (
          <FlowCanvas
            graph={graph}
            semantics={
              bindingsActive &&
              analysis?.revisionId === graph.revisionId &&
              analysis.id === graph.analysisId &&
              analysis?.sourceMapVersion === graph.sourceMapVersion
                ? analysis.semantics
                : undefined
            }
            methodId={methodId}
            selected={selected?.id}
            onSelect={pickNode}
            projectId={projectId}
            stale={stale}
            readOnly={readOnly}
            staleMessage={
              dirty
                ? "Изменения ещё не сохранены"
                : analyzing
                  ? "Обновляем схему…"
                  : analysis?.parseStatus === "invalid"
                    ? "В коде есть синтаксическая ошибка"
                    : "Схему нужно обновить"
            }
            onRefresh={() => {
              if (dirty) void save();
              else if (revision) void analyze(revision);
            }}
            refreshing={saving || analyzing}
            onInsert={(nodeId, kind, position) => {
              const n = graph.nodes.find((n) => n.id === nodeId);
              if (!n || stale) return;
              pickNode(n);
              setDropEdit({ nodeId, kind, position, serial: Date.now() });
              void workspace.reveal("analysis");
            }}
            onEdit={(n) => {
              pickNode(
                operationAnchor(n, graph.nodes, "replace_expression") ?? n,
              );
              void workspace.reveal("analysis");
              setTimeout(
                () =>
                  (
                    document.getElementById("statement-source") ??
                    document.getElementById("expression")
                  )?.focus(),
                0,
              );
            }}
          />
        ) : (
          <div className="empty-pane">
            <span className="empty-glyph">
              <Icon name="workflow" size={32} />
            </span>
            <h2>
              {analysis?.parseStatus === "invalid"
                ? "Исправьте исходник"
                : Object.keys(files).some((p) => p.endsWith(".java"))
                  ? "Схема появится здесь"
                  : "Нет Java-исходников"}
            </h2>
            <p>
              {analysis?.parseStatus === "invalid"
                ? "Откройте диагностику в панели «Анализ»."
                : "Импортируйте .java или выберите метод."}
            </p>
            {!revision && (
              <button onClick={() => setImportChooser(true)}>
                Импорт .java
              </button>
            )}
          </div>
        )}
      </section>
    ),
    code: (
      <section className="code-pane" aria-label="Редактор файлов">
        <div className="file-tabs" role="tablist" aria-label="Открытые файлы">
          {tabs
            .filter((p) => p in files)
            .map((p, i) => (
              <div className="file-tab" key={p}>
                <button
                  role="tab"
                  aria-label={p.split("/").pop()}
                  aria-selected={file === p}
                  onClick={() => {
                    setMethodId(
                      matchingMethod(
                        graph?.methods ?? [],
                        methodSelections.current[p],
                      )?.id ??
                        graph?.methods.find((m) => m.sourceRange.filePath === p)
                          ?.id ??
                        "",
                    );
                    setSelected(null);
                    setFile(p);
                    setRange(null);
                  }}
                >
                  <FileGlyph path={p} />
                  {p.split("/").pop()}
                  {revision && files[p] !== filesOf(revision)[p] ? " •" : ""}
                </button>
                <button
                  aria-label={"Сдвинуть влево " + p}
                  disabled={i === 0}
                  onClick={() =>
                    setTabs((old) => {
                      const n = [...old];
                      [n[i - 1], n[i]] = [n[i], n[i - 1]];
                      return n;
                    })
                  }
                >
                  ‹
                </button>
                <button
                  aria-label={"Закрыть " + p}
                  onClick={() => {
                    setTabs((old) => old.filter((t) => t !== p));
                    if (file === p)
                      setFile(
                        tabs.filter((t) => t !== p && t in files)[0] ?? "",
                      );
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          <button
            className="file-tabs-save"
            disabled={!dirty || saving || conflict || readOnly}
            onClick={() => void save()}
            title="Ctrl+S"
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
        {file && (
          <div className="editor-file-status">
            <span>{(files[file] ?? "").split("\n").length} строк</span>
            <span>
              {saving
                ? "Сохраняем…"
                : dirty
                  ? "Изменения не сохранены"
                  : analyzing
                    ? "Обновляем схему…"
                    : "Сохранено"}
            </span>
          </div>
        )}
        {file &&
          (() => {
            const type = publicJavaType(files[file] ?? "");
            const name = file.split("/").pop();
            const target =
              file.slice(0, file.lastIndexOf("/") + 1) + type + ".java";
            return languageFor(file) === "java" &&
              type &&
              name !== type + ".java" ? (
              <div className="notice filename-notice">
                Публичный класс {type} должен находиться в файле {type}.java.
                <button
                  onClick={() =>
                    void changePath("move", file, target).catch((e) =>
                      setError(message(e)),
                    )
                  }
                >
                  Переименовать в {type}.java
                </button>
              </div>
            ) : null;
          })()}
        {file && Object.hasOwn(files, file) ? (
          <CodeEditor
            onReady={(commands) => {
              editorCommands.current = commands;
              setEditorReady(true);
            }}
            path={projectId + "/" + file}
            modelPath={modelId(file)}
            language={languageFor(file)}
            value={files[file] ?? ""}
            onChange={edit}
            range={
              range &&
              !dirty &&
              analysis?.revisionId === revision?.id &&
              (analysis?.parseStatus === "valid" ||
                range.diagnosticRevisionId === revision?.id)
                ? { ...range, filePath: projectId + "/" + range.filePath }
                : null
            }
            diagnostics={(dirty ? [] : (analysis?.diagnostics ?? [])).map(
              (d) => ({
                ...d,
                sourceRange: d.sourceRange
                  ? {
                      ...d.sourceRange,
                      filePath: projectId + "/" + d.sourceRange.filePath,
                    }
                  : null,
              }),
            )}
            onOffset={offset}
            readOnly={readOnly || busy || treeSaving || loadingRevision}
          />
        ) : (
          <div className="empty-pane">
            <p>
              {loadingRevision ? "Загрузка исходника…" : "Исходник не загружен"}
            </p>
          </div>
        )}
      </section>
    ),
    analysis: (
      <aside className="inspector">
        {graph?.nodes.some(
          (node) => node.methodId === methodId && node.kind === "opaque",
        ) && (
          <div
            className="notice"
            role="status"
            data-testid="opaque-method-notice"
          >
            Внутренний поток этого метода не раскрыт: есть неподдерживаемая
            конструкция или превышен лимит анализа. Составной блок показывает
            исходный код целиком, а не полную схему ветвлений. Причина указана в
            диагностике анализа.
          </div>
        )}
        <CodeInsights
          analysis={analysis}
          methodId={methodId}
          focusKey={inspectorFocus}
          optimizationEnabled={!inFlight && !readOnly && !stale}
          onOptimize={(nodeId) => {
            if (inFlight || readOnly || stale) return;
            const node = graph?.nodes.find(
              (item) =>
                item.id === nodeId &&
                item.allowedOperations?.includes("optimize_membership"),
            );
            if (!node) return;
            setMethodId(node.methodId);
            pickNode(node);
            setOptimizationEdit((previous) => ({
              nodeId,
              serial: (previous?.serial ?? 0) + 1,
            }));
          }}
          current={
            !!analysis &&
            analysis.revisionId === revision?.id &&
            !dirty &&
            !loadingRevision
          }
          onNavigate={(target, targetMethod) => {
            if (
              !analysis ||
              analysis.revisionId !== revision?.id ||
              dirty ||
              loadingRevision
            )
              return;
            setRange({ ...target, diagnosticRevisionId: analysis.revisionId });
            setFile(target.filePath);
            setSelected(null);
            const enclosing =
              targetMethod ??
              graph?.methods.find(
                (m) =>
                  m.sourceRange.filePath === target.filePath &&
                  m.sourceRange.startOffset <= target.startOffset &&
                  target.endOffset <= m.sourceRange.endOffset,
              )?.id;
            if (enclosing) setMethodId(enclosing);
            setMode("split");
          }}
        >
          {!selected && (
            <div className="analysis-summary">
              <strong>
                <Check size={21} />
                {stale
                  ? "Есть изменения"
                  : analysis?.parseStatus === "valid"
                    ? "Синтаксис проверен"
                    : "Проверка исходника"}
              </strong>
              <dl>
                <dt>Узлы</dt>
                <dd>{methodExecutionNodes.length || "—"}</dd>
                <dt>Связи</dt>
                <dd>
                  {graph?.edges.filter(
                    (e) =>
                      methodNodeIds.has(e.source) &&
                      methodNodeIds.has(e.target),
                  ).length ?? "—"}
                </dd>
              </dl>
            </div>
          )}
          {selected ? (
            <>
              <div
                className={
                  "inspector-selection" +
                  (isIterationProtocol(selected) ? " iteration-protocol" : "")
                }
              >
                <span className="eyebrow">
                  {selected.executionRole === "ast_projection"
                    ? "Исходник"
                    : kindName(selected.kind)}
                </span>
                {!isIterationProtocol(selected) && (
                  <h2>{nodeCaption(selected).split("\n")[0].slice(0, 120)}</h2>
                )}
                <span className="quiet small">
                  {selected.sourceRange
                    ? `${selected.sourceRange.filePath} · строка ${selected.sourceRange.startLine}`
                    : "Служебный узел"}
                </span>
              </div>
              {selected.sourceRange && (
                <button
                  className="wide subtle"
                  onClick={() => {
                    setRange(selected.sourceRange);
                    setMode("split");
                  }}
                >
                  Перейти к коду <Icon name="external" size={14} />
                </button>
              )}
              {operations.length > 0 ? (
                <div className="expression-form">
                  <label htmlFor="node-operation">Действие</label>
                  <select
                    id="node-operation"
                    value={operation}
                    disabled={inFlight || stale || readOnly}
                    onChange={(e) => {
                      setOperation(e.target.value);
                      if (e.target.value === "optimize_membership")
                        setIntent("preserve_behavior");
                    }}
                  >
                    {operations.map((op) => (
                      <option key={op} value={op}>
                        {operationLabels[op]}
                      </option>
                    ))}
                  </select>
                  {operation === "replace_expression" &&
                    editRange(selected) && (
                      <>
                        <label htmlFor="expression">
                          {selected.editableFields[0] === "condition"
                            ? "Условие"
                            : "Выражение"}
                        </label>
                        <textarea
                          id="expression"
                          value={expression}
                          onChange={(e) => setExpression(e.target.value)}
                          rows={5}
                          spellCheck={false}
                          disabled={inFlight || stale || readOnly}
                        />
                      </>
                    )}
                  {operation === "replace_statement" && (
                    <>
                      <label htmlFor="statement-source">Код блока</label>
                      <textarea
                        id="statement-source"
                        rows={6}
                        value={statement}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setStatement(e.target.value)}
                        spellCheck={false}
                      />
                    </>
                  )}
                  {operation === "insert_statement" && (
                    <>
                      <label htmlFor="insert-position">Позиция</label>
                      <select
                        id="insert-position"
                        value={position}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setPosition(e.target.value)}
                      >
                        {positions.map((p) => (
                          <option key={p} value={p}>
                            {(
                              {
                                before: "Перед узлом",
                                after: "После узла",
                                body_start: "В начале метода",
                                body_end: "В конце метода",
                              } as Record<string, string>
                            )[p] ?? p}
                          </option>
                        ))}
                      </select>
                      <label htmlFor="statement-template">Шаблон</label>
                      <select
                        id="statement-template"
                        value={template}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => {
                          setTemplate(e.target.value);
                          setStatement(statementTemplates[e.target.value]);
                        }}
                      >
                        <option value="statement">Оператор</option>
                        <option value="condition">Условие</option>
                        <option value="loop">Цикл</option>
                      </select>
                      <label htmlFor="statement-source">Java оператор</label>
                      <textarea
                        id="statement-source"
                        value={statement}
                        rows={6}
                        spellCheck={false}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setStatement(e.target.value)}
                      />
                    </>
                  )}
                  {operation === "delete_statement" && (
                    <p className="small quiet">Удаление выбранного оператора</p>
                  )}
                  {operation === "move_statement" && (
                    <>
                      <label htmlFor="move-target">
                        Относительно оператора
                      </label>
                      <select
                        id="move-target"
                        value={targetNodeId}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => {
                          setTargetNodeId(e.target.value);
                          const next = targets.find(
                            (n) => n.id === e.target.value,
                          );
                          setMovePosition(
                            selected && next && graph
                              ? (movePositions(selected, next, graph)[0] ?? "")
                              : "",
                          );
                        }}
                      >
                        <option value="">Выберите оператор</option>
                        {targets.map((n) => (
                          <option key={n.id} value={n.id}>
                            {`Строка ${n.sourceRange!.startLine} · ${nodeCaption(n).split("\n")[0].slice(0, 90)}`}
                          </option>
                        ))}
                      </select>
                      <label htmlFor="move-position">Позиция перемещения</label>
                      <select
                        id="move-position"
                        value={movePosition}
                        disabled={inFlight || stale || readOnly || !target}
                        onChange={(e) => setMovePosition(e.target.value)}
                      >
                        {!moveOptions.length && (
                          <option value="">Нет доступной позиции</option>
                        )}
                        {moveOptions.map((p) => (
                          <option key={p} value={p}>
                            {p === "before"
                              ? "Перед оператором"
                              : "После оператора"}
                          </option>
                        ))}
                      </select>
                      {!targets.length && (
                        <p className="small quiet">
                          В этом блоке нет доступных операторов для перемещения.
                        </p>
                      )}
                    </>
                  )}
                  {(operation === "wrap_if" || operation === "wrap_while") && (
                    <>
                      <label htmlFor="wrap-condition">Условие</label>
                      <textarea
                        id="wrap-condition"
                        value={wrapCondition}
                        rows={3}
                        spellCheck={false}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setWrapCondition(e.target.value)}
                      />
                    </>
                  )}
                  {operation === "add_else" && (
                    <>
                      <label htmlFor="else-source">Тело ветки else</label>
                      <textarea
                        id="else-source"
                        value={elseSource}
                        rows={6}
                        spellCheck={false}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setElseSource(e.target.value)}
                      />
                    </>
                  )}
                  {operation === "remove_else" && (
                    <p className="small quiet">
                      Удалить все операторы ветки else
                    </p>
                  )}
                  {operation === "optimize_membership" && (
                    <div
                      className="optimization-assumptions"
                      aria-label="Условия оптимизации"
                    >
                      {analysis?.optimizations
                        ?.find((op) => op.nodeId === selected.id)
                        ?.assumptions.map((assumption, index) => (
                          <p key={index}>{assumption}</p>
                        ))}
                    </div>
                  )}
                  <label htmlFor="change-intent">Цель изменения</label>
                  <select
                    id="change-intent"
                    value={intent}
                    disabled={
                      inFlight ||
                      stale ||
                      readOnly ||
                      operation === "optimize_membership"
                    }
                    onChange={(e) => setIntent(e.target.value)}
                  >
                    <option value="semantic_edit">Изменить логику</option>
                    <option value="preserve_behavior">
                      Сохранить поведение
                    </option>
                  </select>
                  <button
                    className="primary wide"
                    disabled={
                      inFlight ||
                      stale ||
                      readOnly ||
                      !operations.includes(operation) ||
                      !changePayload
                    }
                    onClick={() => void prepare()}
                  >
                    {busy ? "Проверка…" : "Подготовить изменение"}
                  </button>
                  {stale && (
                    <p className="small quiet">
                      Сначала сохраните и исправьте исходник.
                    </p>
                  )}
                </div>
              ) : (
                <p className="inspector-note">Нет доступных действий</p>
              )}
            </>
          ) : (
            <div
              className={
                "inspector-placeholder " +
                (activeReference ? "symbol-selected" : "")
              }
            >
              <span>
                <Icon name="workflow" size={27} />
              </span>
              <p>Выберите узел</p>
            </div>
          )}

          {symbolPanel}
          <div className="inspector-section">
            <div className="panel-caption">
              ВЫРАЖЕНИЯ <span>{expressions.length}</span>
            </div>
            <div className="expression-list">
              {expressions.map((n) => (
                <button
                  key={n.id}
                  className={selected?.id === n.id ? "active" : ""}
                  onClick={() => pickNode(n)}
                  disabled={stale}
                >
                  <span>{n.sourceRange?.startLine}</span>
                  <code>{n.label.split("\n")[0].slice(0, 85)}</code>
                </button>
              ))}
            </div>
          </div>
          {graph && (
            <details className="node-access">
              <summary>Все узлы метода</summary>
              {graph.nodes
                .filter((n) => n.methodId === methodId)
                .map((n) => (
                  <button key={n.id} onClick={() => pickNode(n)}>
                    {isIterationProtocol(n)
                      ? nodeCaption(n)
                      : `${kindName(n.kind)} · ${nodeCaption(n).slice(0, 55)}`}
                  </button>
                ))}
            </details>
          )}
        </CodeInsights>
      </aside>
    ),
    console: (
      <div className="dock-content">
        <>
          {job?.type === "run" &&
            (dirty ||
              ((job.revisionId ?? report?.revisionId) &&
                (job.revisionId ?? report?.revisionId) !== revision?.id)) && (
              <div
                className="notice"
                role="status"
                data-testid="run-source-provenance"
              >
                {(job.revisionId ?? report?.revisionId)
                  ? `Вывод запуска версии ${short(job.revisionId ?? report?.revisionId)}.`
                  : "Вывод запуска сохранённой версии."}
                {dirty
                  ? " Локальный черновик ещё не запускался."
                  : " Это запуск предыдущей версии. Текущая версия кода отличается; запустите её для нового вывода."}
              </div>
            )}
          {job?.type === "run" && ["queued", "running"].includes(job.status) ? (
            <LiveConsole
              projectId={projectId}
              jobId={job.id}
              live={job.live}
              readOnly={accessReadOnly}
            />
          ) : report ? (
            <ReportView
              report={report}
              projectId={projectId}
              cancelled={job?.status === "cancelled"}
            />
          ) : job?.status === "cancelled" ? (
            <div className="output-empty">Запуск отменён</div>
          ) : job?.error ? (
            <div className="notice error">
              {job.error.code} · {job.error.message}
            </div>
          ) : (
            !analysis?.diagnostics.length && (
              <div className="output-empty">
                <span className="terminal-prompt">
                  <Icon name="terminal" size={17} />
                </span>
                <span>
                  {runnerAvailable === false
                    ? "Запуск недоступен: runner не подключён. Редактор и схема доступны."
                    : "Нет вывода"}
                </span>
                <kbd>Ctrl ↵</kbd>
              </div>
            )
          )}
        </>
      </div>
    ),
    tests: (
      <div className="dock-content">
        {job?.type === "compare" &&
        (!report?.testResults || ["queued", "running"].includes(job.status)) ? (
          <TestProgressView job={job} />
        ) : report?.testResults ? (
          <>
            {proposal?.status === "ready" && exactMatched && (
              <div className="verified-change">
                <button className="subtle" onClick={() => setDock("changes")}>
                  К изменению <Icon name="external" size={13} />
                </button>
              </div>
            )}
            <ReportView report={report} projectId={projectId} />
          </>
        ) : (
          <div className="output-empty">
            <span className="terminal-prompt">
              <Icon name="compare" size={17} />
            </span>
            <span>Нет сравнений</span>
            <button
              onClick={() => setDialog("compare")}
              disabled={accessReadOnly || !revision || dirty}
            >
              Сравнить версии
            </button>
          </div>
        )}
      </div>
    ),
    changes: (
      <div className="dock-content">
        {proposal ? (
          <div className="proposal">
            <div className="proposal-heading">
              <span>
                Кандидат {short(proposal.candidateRevisionId)}{" "}
                <span className="status-tag">
                  {proposal.status === "ready"
                    ? "Скомпилирован"
                    : proposal.status === "rejected"
                      ? "Изменение не применено"
                      : "Проверка…"}
                </span>
              </span>
              <span className="small quiet">
                {proposal.intent === "semantic_edit"
                  ? "Изменение логики"
                  : "Сохранение поведения"}
              </span>
              {proposal.intent === "preserve_behavior" &&
                proposal.status === "ready" &&
                proposal.candidateRevisionId &&
                !exactMatched && (
                  <button
                    className="primary"
                    disabled={inFlight || readOnly || dirty || conflict}
                    onClick={() => setDialog("compare")}
                  >
                    Проверить на тестах
                  </button>
                )}
              <button
                className="primary"
                disabled={
                  inFlight ||
                  readOnly ||
                  conflict ||
                  !canApply(
                    proposal.status,
                    proposal.baseRevisionId,
                    project?.headRevisionId ?? null,
                    proposal.intent,
                    exactMatched,
                  ) ||
                  dirty
                }
                onClick={() => void apply()}
              >
                Применить
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  proposalEpoch.current++;
                  clearPrepared(projectId, proposal.id);
                  setProposal(null);
                }}
              >
                Отклонить
              </button>
            </div>
            {proposal.diff?.map((d, i) => (
              <div key={i} className="diff">
                <span className="small quiet">{d.filePath}</span>
                <pre className="removed">− {d.before}</pre>
                <pre className="added">+ {d.after}</pre>
              </div>
            ))}
            {proposal.compileExecution &&
              proposal.compileExecution.outcome !== "exited" && (
                <ExecutionView
                  title="Ошибка компиляции"
                  execution={proposal.compileExecution}
                />
              )}
            {proposal.checks && (
              <p className="small quiet">
                Разбор: {proposal.checks.parseStatus} · Компиляция:{" "}
                {proposal.checks.compileStatus} · Проверка поведения:{" "}
                {proposal.checks.verificationStatus}
              </p>
            )}
            {proposal.error && (
              <div className="notice error" role="alert">
                {proposal.error.message}
              </div>
            )}
            {proposal.diagnostics?.map((d) => (
              <p key={d.id}>{d.message}</p>
            ))}
          </div>
        ) : (manualSaveRequired || conflict) && revision ? (
          <div className="local-diff">
            <div className="proposal-heading">
              <span>Локальная правка · основа {short(baseId)}</span>
              <button onClick={() => void save()} disabled={conflict || saving}>
                Сохранить новую версию
              </button>
              <button onClick={downloadDraft}>Скачать черновик</button>
            </div>
            {Object.entries(files)
              .filter(([path, text]) => filesOf(revision)[path] !== text)
              .map(([path, text]) => (
                <div className="diff" key={path}>
                  <span className="small quiet">{path}</span>
                  <pre className="removed">{filesOf(revision)[path] ?? ""}</pre>
                  <pre className="added">{text}</pre>
                </div>
              ))}
          </div>
        ) : (
          <div className="output-empty">
            <span className="terminal-prompt">
              <Icon name="changes" size={17} />
            </span>
            <span>Нет предложений</span>
          </div>
        )}
      </div>
    ),
  };
  function stopJob() {
    if (accessReadOnly) return;
    if (job && ["queued", "running"].includes(job.status))
      void api<Job>(base + "/jobs/" + job.id + "/cancel", {
        method: "POST",
        body: {},
      })
        .then(setJob)
        .catch((e) => setError(message(e)));
  }
  return (
    <div
      className="workbench configurable-workbench glass-workbench"
      data-readonly={accessReadOnly || undefined}
    >
      <header className="toolbar glass-topbar">
        <label className="global-search">
          <Icon name="search" size={17} />
          <input
            ref={searchInput}
            aria-label="Поиск файлов и методов"
            placeholder="Поиск по проекту"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value) void workspace.reveal("project");
            }}
          />
          <kbd>Ctrl K</kbd>
        </label>
        <span className="toolbar-spacer" />
        <button
          className="local-presence"
          title="Аккаунт"
          aria-label="Открыть настройки аккаунта"
          onClick={() => navigate("/settings")}
        >
          <CircleUserRound size={23} />
        </button>
        <button
          className="share-button"
          title="Доступ к проекту"
          onClick={() => setShowAccess(true)}
          disabled={!project}
        >
          <Share2 size={16} /> Поделиться
        </button>
        <input
          type="file"
          multiple
          accept=".zip,.java,.txt,.md,.json,.xml,.yaml,.yml,.py,.js,.ts,.html,.css,.sql,.sh,.ps1"
          ref={importInput}
          hidden
          onChange={(e) => void importFiles(e.target.files)}
        />
      </header>
      {showAccess && project && (
        <ProjectAccess
          project={project}
          onClose={() => setShowAccess(false)}
          onUpdate={setProject}
        />
      )}
      <main className="workbench-body">
        <div className="workspace-notices">
          {" "}
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              <button
                aria-label="Закрыть сообщение"
                onClick={() => setError("")}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {accessReadOnly && (
            <div className="notice" role="status">
              {checkingAccess
                ? "Проверка доступа…"
                : "Проект открыт для просмотра."}
              {dirty &&
                " Локальный черновик сохранён в браузере; автосохранение остановлено."}
              {dirty && (
                <button onClick={downloadDraft}>Скачать черновик</button>
              )}
            </div>
          )}
          {conflict && (
            <div className="notice warning">
              Конфликт версий{" "}
              <button onClick={() => void rebase()}>
                Выбрать актуальную основу
              </button>
              <button onClick={downloadDraft}>Скачать черновик</button>
            </div>
          )}
          {historical && (
            <div className="notice">
              Просмотр сохранённой версии {short(revision?.id)}{" "}
              <button
                disabled={inFlight || dirty}
                onClick={() => void openRevision(project!.headRevisionId!)}
              >
                Открыть текущую
              </button>
            </div>
          )}
        </div>
        <Workspace
          controller={workspace}
          panels={panels}
          canvasTitle={
            <>
              <div className="canvas-breadcrumb">
                {project?.name ?? "Проект"}
                <span>›</span>
                {file}
              </div>
              <h1>{file.split("/").pop() || "JavaBlueprints"}</h1>
              <p>{method?.signature ?? "Выберите метод"}</p>
            </>
          }
          sidebarChrome={
            <>
              <Brand />
              <nav
                className="sidebar-navigation"
                aria-label="Навигация проекта"
              >
                <button onClick={() => navigate("/")}>
                  <House size={19} />
                  Проекты
                </button>
                <button
                  className="active"
                  onClick={() => void workspace.reveal("graph")}
                >
                  <Icon name="file" size={19} />
                  Редактор
                </button>
                <button
                  onClick={() => {
                    void workspace
                      .reveal("project")
                      .then(() =>
                        document
                          .getElementById("project-history")
                          ?.setAttribute("open", ""),
                      );
                  }}
                >
                  <History size={19} />
                  История
                </button>
                <details className="sidebar-settings">
                  <summary>
                    <Settings2 size={19} />
                    Настройки
                  </summary>
                  <div className="sidebar-settings-body">
                    <ThemeToggle />
                    <button onClick={() => void workspace.preset("default")}>
                      Сбросить расположение
                    </button>
                  </div>
                </details>
              </nav>
              <details className="sidebar-command-menu">
                <summary>
                  Меню проекта
                  <ChevronDown size={14} />
                </summary>
                <WorkspaceMenu
                  workspace={workspace}
                  actions={{
                    createFile: () => {
                      workspace.reveal("project");
                      setCreateCommand({ kind: "file", id: Date.now() });
                    },
                    createFolder: () => {
                      workspace.reveal("project");
                      setCreateCommand({ kind: "folder", id: Date.now() });
                    },
                    save: () => void save(),
                    import: () => setImportChooser(true),
                    export: () => void exportRevision(),
                    projects: () => navigate("/"),
                    run: () => setDialog("run"),
                    compare: () => setDialog("compare"),
                    stop: stopJob,
                    edit: (command) => {
                      void workspace.reveal("code").then(() => {
                        if (mounted.current)
                          editorCommands.current?.[command]();
                      });
                    },
                    editDisabled: !file || readOnly || busy || loadingRevision,
                    saveDisabled: !dirty || saving || conflict || readOnly,
                    runDisabled:
                      accessReadOnly ||
                      !revision ||
                      dirty ||
                      busy ||
                      !Object.keys(files).some((p) => p.endsWith(".java")),
                    exportDisabled: !revision || busy,
                    importDisabled: busy || readOnly,
                    stopDisabled:
                      !job || !["queued", "running"].includes(job.status),
                  }}
                />
              </details>
            </>
          }
        />
      </main>
      <footer
        className="workspace-dock-row"
        aria-label="Инструменты рабочего пространства"
      >
        <div className="workspace-dock">
          <button
            className="dock-icon"
            aria-label="Схема"
            title="Схема"
            onClick={() => void workspace.reveal("graph")}
          >
            <MousePointer2 size={20} />
          </button>
          <button
            className="dock-icon"
            aria-label="Добавить блок"
            title="Блоки"
            aria-pressed={activePanels(workspace.layout).includes("palette")}
            onClick={() =>
              activePanels(workspace.layout).includes("palette")
                ? void workspace.hide("palette")
                : void workspace.reveal("palette")
            }
          >
            <Plus size={21} />
          </button>
          <span className="dock-divider" />
          {(
            [
              ["code", "code", "Код"],
              ["console", "terminal", "Консоль"],
              ["tests", "compare", "Тесты"],
            ] as const
          ).map(([panel, icon, label]) => (
            <button
              key={panel}
              aria-pressed={activePanels(workspace.layout).includes(panel)}
              onClick={() =>
                activePanels(workspace.layout).includes(panel)
                  ? void workspace.hide(panel)
                  : void workspace.reveal(panel)
              }
            >
              <Icon name={icon} size={18} />
              <span>{label}</span>
            </button>
          ))}
          <details className="dock-windows-menu">
            <summary aria-label="Окна" title="Окна">
              <PanelsTopLeft size={18} />
            </summary>
            <div className="dock-run-popup">
              {(["project", "palette", "analysis", "changes"] as const).map(
                (panel) => (
                  <button
                    key={panel}
                    aria-pressed={activePanels(workspace.layout).includes(
                      panel,
                    )}
                    onClick={(e) => {
                      activePanels(workspace.layout).includes(panel)
                        ? void workspace.hide(panel)
                        : void workspace.reveal(panel);
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                  >
                    {
                      {
                        project: "Проект",
                        palette: "Блоки",
                        analysis: "Анализ",
                        changes: "Изменения",
                      }[panel]
                    }
                  </button>
                ),
              )}
              <button
                onClick={(e) => {
                  void workspace.preset("default");
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                Сбросить расположение
              </button>
            </div>
          </details>
          <span className="dock-divider" />
          <button
            className="dock-icon"
            aria-label="Сравнить"
            title="Сравнить версии"
            disabled={
              accessReadOnly ||
              !revision ||
              dirty ||
              busy ||
              !Object.keys(files).some((p) => p.endsWith(".java"))
            }
            onClick={() => setDialog("compare")}
          >
            <Icon name="compare" size={18} />
          </button>
          <div className="dock-run-control">
            <button
              className="dock-run"
              disabled={
                accessReadOnly ||
                !revision ||
                busy ||
                !Object.keys(files).some((p) => p.endsWith(".java"))
              }
              onClick={() => {
                if (dirty)
                  void save().then((ok) => {
                    if (ok) setDialog("run");
                  });
                else setDialog("run");
              }}
            >
              <Icon name="play" size={20} />
              {job && ["queued", "running"].includes(job.status)
                ? "В процессе"
                : "Запуск"}
            </button>
            <details className="dock-run-menu">
              <summary aria-label="Параметры запуска">
                <ChevronDown size={16} />
              </summary>
              <div className="dock-run-popup">
                <button
                  disabled={accessReadOnly || !revision || dirty || busy}
                  onClick={(e) => {
                    setDialog("run");
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Настроить запуск
                </button>
                <button
                  disabled={accessReadOnly || !revision || dirty || busy}
                  onClick={(e) => {
                    setDialog("compare");
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Сравнить версии
                </button>
                <button
                  onClick={(e) => {
                    void workspace.reveal("tests");
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Результаты тестов
                </button>
              </div>
            </details>
          </div>
          {job &&
            !accessReadOnly &&
            ["queued", "running"].includes(job.status) && (
              <button
                className="dock-icon stop-job"
                aria-label="Остановить выполнение"
                onClick={stopJob}
              >
                <Square size={17} />
              </button>
            )}
        </div>
      </footer>
      <input
        type="file"
        multiple
        ref={folderInput}
        hidden
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => void importFiles(e.target.files)}
      />
      {(importChooser || importPreview) && (
        <div className="modal-backdrop">
          <section
            className="modal import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <div className="modal-heading">
              <h2 id="import-title">Импорт файлов</h2>
              <button
                aria-label="Закрыть импорт"
                disabled={saving}
                onClick={() => {
                  setImportChooser(false);
                  setImportPreview(null);
                }}
              >
                ×
              </button>
            </div>
            {importPreview ? (
              <>
                <p className="small quiet">
                  Совпадающие пути не перезаписываются.
                </p>
                <div className="import-selection">
                  {[
                    ...importPreview.directories,
                    ...importPreview.files.map((f) => f.path),
                  ]
                    .sort((a, b) => a.localeCompare(b))
                    .map((p) => (
                      <label
                        key={p}
                        style={{
                          paddingLeft: 10 + (p.split("/").length - 1) * 14,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={importSelected.includes(p)}
                          onChange={(e) => {
                            const subtree = [
                              ...importPreview.directories,
                              ...importPreview.files.map((f) => f.path),
                            ].filter((x) => x === p || x.startsWith(p + "/"));
                            setImportSelected((old) =>
                              e.target.checked
                                ? [...new Set([...old, ...subtree])]
                                : old.filter((x) => !subtree.includes(x)),
                            );
                          }}
                        />
                        {importPreview.directories.includes(p) ? (
                          <Icon name="chevron" size={12} />
                        ) : (
                          <FileGlyph path={p} />
                        )}
                        {p}
                        {importPreview.directories.includes(p) ? "/" : ""}
                        {p in files ? " · путь занят" : ""}
                      </label>
                    ))}
                </div>
                {error && (
                  <div className="notice error" role="alert">
                    {error}
                  </div>
                )}
                <div className="modal-actions">
                  <button onClick={() => setImportPreview(null)}>Назад</button>
                  <button
                    className="primary"
                    disabled={
                      !importSelected.length || saving || readOnly || conflict
                    }
                    onClick={() => void applyImport()}
                  >
                    {saving ? "Импорт…" : "Импортировать выбранное"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  disabled={busy}
                  onClick={() => importInput.current?.click()}
                >
                  Выбрать ZIP или файлы
                </button>
                <button
                  disabled={busy}
                  onClick={() => folderInput.current?.click()}
                >
                  Выбрать папку
                </button>
                <p className="small quiet">
                  Текстовые файлы UTF-8. Анализ и запуск доступны для Java.
                  Пустые папки можно импортировать из ZIP или создать в проекте.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {dialog && project && revision && !accessReadOnly && (
        <RunDialog
          kind={dialog}
          project={project}
          revision={revision}
          proposal={proposal}
          historyRows={historyRows}
          onClose={() => setDialog(null)}
          onStart={(j) => {
            setJob(j);
            setDock(dialog === "compare" ? "tests" : "output");
            navigate(`/projects/${projectId}/runs/${j.id}`);
            setDialog(null);
          }}
          onError={(e) => setError(e)}
        />
      )}
    </div>
  );
}
function RunDialog({
  kind,
  project,
  revision,
  proposal,
  historyRows,
  onClose,
  onStart,
  onError,
}: {
  kind: "run" | "compare";
  project: Project;
  revision: Revision;
  proposal: Proposal | null;
  historyRows: Revision[];
  onClose: () => void;
  onStart: (j: Job) => void;
  onError: (e: string) => void;
}) {
  const [entry, setEntry] = useState(() => {
    const source = revision.files.find((f) =>
      /static\s+void\s+main\s*\(/.test(f.canonicalText),
    );
    const name = source?.path.split("/").pop()?.replace(".java", "") ?? "";
    const pkg = source?.canonicalText.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
    return pkg ? pkg + "." + name : name;
  });
  const [argv, setArgv] = useState("[]");
  const [stdin, setStdin] = useState("");
  const [cases, setCases] = useState(
    '[\n  {"id":"case-1","name":"Вход 1","stdinUtf8":"7\\n","argv":[]},\n  {"id":"case-2","name":"Вход 2","stdinUtf8":"21\\n","argv":[]},\n  {"id":"case-3","name":"Вход 3","stdinUtf8":"99\\n","argv":[]}\n]',
  );
  const [caseFormError, setCaseFormError] = useState<string | null>(null);
  const [baseRevision, setBaseRevision] = useState(
    proposal?.baseRevisionId ?? project.originalRevisionId ?? revision.id,
  );
  const [candidate, setCandidate] = useState(
    proposal?.candidateRevisionId ?? revision.id,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const focus = useRef<HTMLInputElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const dialogActive = useRef(true);
  useEffect(() => {
    dialogActive.current = true;
    focus.current?.focus();
    return () => {
      dialogActive.current = false;
      requestController.current?.abort();
    };
  }, []);
  async function submit() {
    if (requestController.current || !dialogActive.current) return;
    const controller = new AbortController();
    requestController.current = controller;
    const current = () => dialogActive.current && !controller.signal.aborted;
    setBusy(true);
    setError("");
    try {
      if (!entry.trim()) throw new Error("Укажите класс с main.");
      let j: Job;
      if (kind === "run") {
        const args: unknown = JSON.parse(argv);
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
          throw new Error("Аргументы должны быть JSON-массивом строк.");
        j = await api<Job>(projectPath(project.id) + "/runs", {
          signal: controller.signal,
          method: "POST",
          body: {
            revisionId: revision.id,
            entryPoint: entry.trim(),
            argv: args,
            stdinUtf8: stdin,
            profileId: "java21-v1",
            interactive: true,
          },
        });
      } else {
        const parsed = parseCases(cases);
        if (caseFormError || parsed.error || !parsed.cases)
          throw new Error(
            caseFormError ?? parsed.error ?? "Проверьте тестовые входы",
          );
        const suite = await api<{ id: string }>(
          projectPath(project.id) + "/test-suites",
          {
            signal: controller.signal,
            method: "POST",
            body: {
              mode: "console",
              entryPoint: entry.trim(),
              cases: parsed.cases,
              comparisonPolicyId: "exact-v1",
            },
          },
        );
        if (!current()) return;
        j = await api<Job>(projectPath(project.id) + "/comparisons", {
          signal: controller.signal,
          method: "POST",
          body: {
            baseRevisionId: baseRevision,
            candidateRevisionId: candidate,
            suiteVersionId: suite.id,
            profileId: "java21-v1",
          },
        });
      }
      if (current()) onStart(j);
    } catch (e) {
      if (!current()) return;
      const msg = message(e);
      setError(msg);
      onError(msg);
    } finally {
      if (requestController.current === controller)
        requestController.current = null;
      if (current()) setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const elements = e.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
            );
            if (!elements.length) {
              e.preventDefault();
              return;
            }
            if (e.shiftKey && document.activeElement === elements[0]) {
              e.preventDefault();
              elements[elements.length - 1]?.focus();
            } else if (
              !e.shiftKey &&
              document.activeElement === elements[elements.length - 1]
            ) {
              e.preventDefault();
              elements[0]?.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <h2 id="run-title">
            {kind === "run" ? "Запуск программы" : "Сравнение версий"}
          </h2>
          <button aria-label="Закрыть диалог" onClick={onClose} disabled={busy}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <fieldset className="run-fields" disabled={busy}>
          <label htmlFor="entrypoint">Класс с main</label>
          <input
            ref={focus}
            id="entrypoint"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="com.example.Main"
          />
          {kind === "run" ? (
            <>
              <label htmlFor="argv">Аргументы · JSON-массив</label>
              <input
                id="argv"
                value={argv}
                onChange={(e) => setArgv(e.target.value)}
              />
              <label htmlFor="stdin">Стандартный ввод</label>
              <textarea
                id="stdin"
                rows={6}
                value={stdin}
                onChange={(e) => setStdin(e.target.value)}
                spellCheck={false}
              />
              <p className="small quiet">
                Версия {short(revision.id)} · один запуск · java21-v1
              </p>
            </>
          ) : (
            <>
              <div className="version-pair">
                <label>
                  Базовая версия
                  <select
                    value={baseRevision}
                    onChange={(e) => setBaseRevision(e.target.value)}
                  >
                    {historyRows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {short(r.id)}
                        {r.id === project.originalRevisionId
                          ? " · исходная"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <span>→</span>
                <label>
                  Кандидат
                  <select
                    value={candidate}
                    onChange={(e) => setCandidate(e.target.value)}
                  >
                    {historyRows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {short(r.id)}
                        {r.id === project.headRevisionId ? " · текущая" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <TestCasesEditor
                raw={cases}
                onChange={setCases}
                onValidityChange={setCaseFormError}
              />
              <p className="small quiet">3 запуска каждой версии на вход.</p>
            </>
          )}
        </fieldset>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || (kind === "compare" && !!caseFormError)}
          >
            {busy ? "Отправка…" : kind === "run" ? "Запустить" : "Сравнить"}
          </button>
        </div>
      </section>
    </div>
  );
}
function ReportView({
  report,
  projectId,
  cancelled = false,
}: {
  report: Report;
  projectId: string;
  cancelled?: boolean;
}) {
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSourceHash(null);
    if (report.revisionId)
      api<Revision>(`${projectPath(projectId)}/revisions/${report.revisionId}`)
        .then((snapshot) => {
          if (active) setSourceHash(snapshot.bundleHash);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [projectId, report.revisionId]);
  if (report.revisionId)
    return (
      <SingleRunOutput
        report={report}
        sourceHash={sourceHash}
        cancelled={cancelled}
      />
    );
  return (
    <div className="report">
      {report.revisionId && (
        <div className="run-provenance">
          <span className="run-revision" title={report.revisionId}>
            Версия <code>{short(report.revisionId)}</code>
          </span>
          {sourceHash && (
            <code className="quiet" title={sourceHash}>
              SHA-256 {sourceHash.slice(0, 12)}
            </code>
          )}
          <details className="run-input">
            <summary>Ввод и аргументы</summary>
            <div>
              <code>{report.entryPoint}</code>
              <code>argv {JSON.stringify(report.argv ?? [])}</code>
              <pre aria-label="Стандартный ввод отчёта">
                {report.stdinUtf8 ?? "〈ввод не записан〉"}
              </pre>
            </div>
          </details>
        </div>
      )}
      {report.outcome && (
        <div className={"report-outcome outcome-" + report.outcome}>
          <strong>{labelStatus(report.outcome)}</strong>
          {report.total !== undefined && (
            <span>
              Выполнено{" "}
              {report.completed ??
                report.testResults?.filter(
                  (test) =>
                    test.baseExecutions?.length === 3 &&
                    test.candidateExecutions?.length === 3,
                ).length ??
                0}{" "}
              из {report.total} · Совпало {report.matched ?? 0}
            </span>
          )}
          <span className="small">
            {report.baseRevisionId &&
              `${short(report.baseRevisionId)} → ${short(report.candidateRevisionId)}`}
          </span>
          {report.wallTimeMs !== undefined && (
            <span>{testDuration(report.wallTimeMs)}</span>
          )}
        </div>
      )}
      {report.inconclusiveReasons?.length ? (
        <p>{report.inconclusiveReasons.map(testReason).join(" · ")}</p>
      ) : null}
      {report.baseCompile && (
        <ExecutionView title="Компиляция базы" execution={report.baseCompile} />
      )}
      {report.candidateCompile && (
        <ExecutionView
          title="Компиляция кандидата"
          execution={report.candidateCompile}
        />
      )}
      {report.compileExecution && (
        <ExecutionView title="Компиляция" execution={report.compileExecution} />
      )}{" "}
      {report.runtimeExecution && (
        <ExecutionView title="Программа" execution={report.runtimeExecution} />
      )}{" "}
      {report.testResults?.map((t) => (
        <details className="test-result" key={t.caseId}>
          <summary>
            <span className={"test-dot " + t.verdict} />
            <strong>{t.input?.name ?? t.caseId}</strong>
            <span>
              {(
                {
                  matched: "Совпало",
                  mismatch: "Расхождение",
                  inconclusive: "Неопределённо",
                  not_run: "Не запущено",
                } as Record<string, string>
              )[t.verdict] ?? t.verdict}
            </span>
            <small>
              {t.baseExecutions?.length ?? 0} +{" "}
              {t.candidateExecutions?.length ?? 0} наблюдений
            </small>
            {t.elapsedMs !== undefined && (
              <small className="test-result-duration">
                {testDuration(t.elapsedMs)}
              </small>
            )}
          </summary>
          {t.input && (
            <div className="test-input">
              <span className="small quiet">stdin · {t.input.id}</span>
              <pre>{t.input.stdinUtf8 || "〈пустой ввод〉"}</pre>
              <span className="small quiet">
                argv {JSON.stringify(t.input.argv)}
              </span>
            </div>
          )}
          {(t.reasons?.length ?? 0) > 0 && (
            <p>{t.reasons?.map(testReason).join(" · ")}</p>
          )}
          <div className="execution-pair">
            <div>
              {t.baseExecutions?.map((e, i) => (
                <ExecutionView
                  key={i}
                  title={"База · " + (i + 1)}
                  execution={e}
                />
              ))}
            </div>
            <div>
              {t.candidateExecutions?.map((e, i) => (
                <ExecutionView
                  key={i}
                  title={"Кандидат · " + (i + 1)}
                  execution={e}
                />
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
function ExecutionView({
  title,
  execution: e,
}: {
  title: string;
  execution: import("./types").Execution;
}) {
  return (
    <div className="execution">
      <div className="execution-heading">
        <span>{title}</span>
        <code>
          {e.outcome} {e.exitCode !== undefined ? "· exit " + e.exitCode : ""}{" "}
          {e.wallTimeMs !== undefined ? "· " + e.wallTimeMs + " ms" : ""}
        </code>
      </div>
      {e.stdoutUtf8 !== undefined && (
        <pre>{e.stdoutUtf8 || "〈stdout пуст〉"}</pre>
      )}
      {e.stderrUtf8 && <pre className="stderr">{e.stderrUtf8}</pre>}
      {e.truncated && <p className="warning">Вывод обрезан</p>}
    </div>
  );
}
