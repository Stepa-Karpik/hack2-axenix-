import { ThemeToggle } from "./theme";
import Workspace, { useWorkspace } from "./Workspace";
import WorkspaceMenu from "./WorkspaceMenu";

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
import CodeEditor from "./CodeEditor";
import FlowCanvas, {
  kindName,
  nodeCaption,
  isIterationProtocol,
} from "./FlowCanvas";
import SymbolInspector from "./SymbolInspector";
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
}
function readView(id: string): Partial<WorkbenchView> {
  try {
    const view = JSON.parse(
      localStorage.getItem("java-blueprints:view:" + id) ?? "{}",
    );
    return {
      file: typeof view?.file === "string" ? view.file : undefined,
      methodId: typeof view?.methodId === "string" ? view.methodId : undefined,
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
      <span className="brand-mark">jb</span>
      <span>
        Java<span className="brand-light">Blueprints</span>
      </span>
    </a>
  );
}
export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const change = () => setPath(location.pathname);
    addEventListener("popstate", change);
    return () => removeEventListener("popstate", change);
  }, []);
  const match = path.match(/^\/projects\/([^/]+)(?:\/runs\/([^/]+))?\/?$/);
  return match ? (
    <Workbench key={match[1]} projectId={match[1]} runId={match[2]} />
  ) : (
    <Projects />
  );
}
function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  }, []);
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
        <ThemeToggle />
        <span className="quiet small">Java 21 · локальное рабочее место</span>
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
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button onClick={() => location.reload()}>Повторить</button>
          </div>
        )}
        <div className="project-list">
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
        </div>
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
  const initialView = useRef(readView(projectId)).current;
  const [project, setProject] = useState<Project | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [historyRows, setHistoryRows] = useState<Revision[]>([]);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [baseId, setBaseId] = useState("");
  const [file, setFile] = useState(initialView.file ?? "");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [methodId, setMethodId] = useState(initialView.methodId ?? "");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [range, setRange] = useState<SourceRange | null>(null);
  const workspace = useWorkspace(projectId);
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
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"run" | "compare" | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loadingRevision, setLoadingRevision] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const [operation, setOperation] = useState("");
  const [position, setPosition] = useState("");
  const [template, setTemplate] = useState("statement");
  const [statement, setStatement] = useState(statementTemplates.statement);
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
        JSON.stringify({ file, methodId }),
      );
    } catch {}
  }, [projectId, file, methodId]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const dirty = revision
    ? hasChanges(files, filesOf(revision))
    : Object.keys(files).length > 0;
  const historical = !!revision && revision.id !== project?.headRevisionId;
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
      setStatus("Разбор…");
      try {
        let a: Analysis;
        try {
          a = await api<Analysis>(`${base}/revisions/${r.id}/analysis`);
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== "ANALYSIS_NOT_READY")
            throw e;
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
          setMethodId((old) =>
            a.graph!.methods.some((m) => m.id === old)
              ? old
              : (a.graph!.methods[0]?.id ?? ""),
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
      }
    },
    [base, track],
  );
  const refreshHistory = useCallback(
    () => api<Revision[]>(base + "/revisions?limit=100").then(setHistoryRows),
    [base],
  );
  async function openRevision(id: string, restore = false) {
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
      if (restore) {
        try {
          const raw = localStorage.getItem(draftKey(projectId));
          if (raw) {
            const draft = JSON.parse(raw) as Draft;
            if (draft.files && typeof draft.baseRevisionId === "string") {
              text = draft.files;
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
        else setStatus("Добавьте исходники");
      })
      .catch((e) => setError(message(e)));
    return () => {
      mounted.current = false;
      generation.current++;
      controllers.current.forEach((c) => c.abort());
    };
  }, [projectId]);
  useEffect(() => {
    if (!revision || !Object.keys(files).length || (historical && !dirty))
      return;
    try {
      if (dirty)
        localStorage.setItem(
          draftKey(projectId),
          JSON.stringify({ baseRevisionId: baseId, files }),
        );
      else if (!conflict) localStorage.removeItem(draftKey(projectId));
    } catch {
      setError("Локальное хранилище недоступно. Сохраните исходник на сервер.");
    }
  }, [files, baseId, revision, projectId, dirty, historical, conflict]);
  const save = useCallback(async () => {
    if (
      savingRef.current ||
      !project ||
      !Object.keys(filesRef.current).length ||
      conflict ||
      historical ||
      busy ||
      loadingRevision
    )
      return;
    const snapshot = filesRef.current;
    if (revision && !hasChanges(snapshot, filesOf(revision))) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const r = await api<Revision>(base + "/revisions", {
        method: "POST",
        head: baseId || null,
        body: {
          files: Object.entries(snapshot).map(([path, content]) => ({
            path,
            content,
          })),
          intent: "semantic_edit",
          expectedHeadRevisionId: baseId || "empty",
        },
      });
      if (!mounted.current) return;
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
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        setConflict(true);
        setError(
          "Версия изменилась в другом окне. Локальная правка сохранена.",
        );
      } else setError(message(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    project,
    conflict,
    historical,
    busy,
    loadingRevision,
    revision,
    base,
    baseId,
    refreshHistory,
    analyze,
  ]);
  useEffect(() => {
    if (!dirty || conflict || historical || !revision || manualSaveRequired)
      return;
    const timer = setTimeout(() => void save(), 1800);
    return () => clearTimeout(timer);
  }, [files, dirty, conflict, historical, revision, save, manualSaveRequired]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        setDialog(e.shiftKey ? "compare" : "run");
      }
      if (e.key === "Escape") {
        setDialog(null);
        workspace.setMaximized(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save]);
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
                setDock("tests");
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
    setFiles((f) => ({ ...f, [file]: text }));
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
    if (!list?.length || !project) return;
    setBusy(true);
    setError("");
    try {
      if (dirty)
        throw new Error(
          "Сначала сохраните локальную правку или экспортируйте её.",
        );
      const data = new FormData();
      Array.from(list).forEach((f) => data.append("files", f, f.name));
      data.append("languageProfileId", "java21-v1");
      const r = await api<Revision>(base + "/imports", {
        method: "POST",
        head: project.headRevisionId,
        body: data,
      });
      setProject({
        ...project,
        headRevisionId: r.id,
        originalRevisionId: project.originalRevisionId ?? r.id,
      });
      await openRevision(r.id);
      void refreshHistory();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  }
  const operations = nodeOperations(selected);
  const positions = selected?.insertionPositions ?? [];
  useEffect(() => {
    setOperation(nodeOperations(selected)[0] ?? "");
    setPosition(selected?.insertionPositions?.[0] ?? "");
    setTemplate("statement");
    setStatement(statementTemplates.statement);
    setIntent("semantic_edit");
    setProposal(null);
  }, [selected?.id, revision?.id]);
  useEffect(() => {
    setProposal(null);
  }, [operation, position, statement, expression, intent]);
  const inFlight =
    busy ||
    saving ||
    loadingRevision ||
    !!dialog ||
    (!!job && ["queued", "running"].includes(job.status));
  async function restoreRevision(sourceId: string) {
    if (
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
      historical ||
      inFlight ||
      !operations.includes(operation) ||
      (operation === "insert_statement" &&
        (!positions.includes(position) || !statement.trim())) ||
      (operation === "replace_expression" &&
        (!editRange(selected) || !expression.trim()))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const p = await api<Proposal>(base + "/changes", {
        method: "POST",
        body: {
          baseRevisionId: revision.id,
          analysisId: analysis.id,
          methodId: selected.methodId,
          nodeId: selected.id,
          operation,
          payload:
            operation === "delete_statement"
              ? {}
              : operation === "insert_statement"
                ? { position, source: statement }
                : { field: selected.editableFields[0], source: expression },
          intent,
        },
      });
      setProposal(p);
      setDock("changes");
      const final = await track({
        id: p.jobId,
        status: "queued",
        type: "change",
      });
      const ready = await api<Proposal>(base + "/changes/" + p.id);
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
      historical ||
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
  async function exportRevision() {
    if (!revision) return;
    setBusy(true);
    try {
      const result = await api<{ downloadUrl: string }>(base + "/exports", {
        method: "POST",
        body: {
          revisionId: revision.id,
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
  const panels = {
    project: (
      <aside className="sidebar">
        <div className="panel-caption">
          ПРОЕКТ <span>JAVA 21</span>
        </div>
        <label className="search">
          <Icon name="search" size={14} />
          <input
            aria-label="Поиск файлов и методов"
            placeholder="Найти файл или метод"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>/</kbd>
        </label>
        <div className="file-tree">
          {Object.keys(files)
            .filter(
              (f) =>
                f.toLowerCase().includes(search.toLowerCase()) ||
                graph?.methods.some(
                  (m) =>
                    m.sourceRange.filePath === f &&
                    m.signature.toLowerCase().includes(search.toLowerCase()),
                ),
            )
            .map((f) => (
              <div key={f}>
                <button
                  className={"file-item " + (file === f ? "active" : "")}
                  onClick={() => {
                    setFile(f);
                    workspace.reveal("code");
                    setReferenceId(null);
                    setRange(null);
                  }}
                >
                  <Icon name="file" size={15} />
                  {f}
                  <span className="file-chevron">
                    <Icon name="chevron" size={12} />
                  </span>
                </button>
                {graph?.methods
                  .filter(
                    (m) =>
                      m.sourceRange.filePath === f &&
                      m.signature.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((m) => (
                    <button
                      key={m.id}
                      className={
                        "method-item " + (methodId === m.id ? "active" : "")
                      }
                      disabled={inFlight}
                      onClick={() => {
                        setMethodId(m.id);
                        workspace.reveal("graph");
                        setFile(f);
                        setRange(m.sourceRange);
                        setSelected(null);
                        setReferenceId(null);
                      }}
                    >
                      <Icon name="method" size={12} />
                      {m.signature}
                    </button>
                  ))}
              </div>
            ))}
        </div>
        <div className="sidebar-bottom">
          <div className="panel-caption">
            ИСТОРИЯ{" "}
            <button
              title="Обновить историю"
              aria-label="Обновить историю"
              onClick={() => void refreshHistory()}
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
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
                    disabled={inFlight || dirty || conflict}
                    onClick={() => void restoreRevision(r.id)}
                  >
                    Восстановить
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="local-label">
            <span className="connection-dot" /> Локальное хранилище
          </div>
        </div>
      </aside>
    ),
    palette: (
      <div className="block-palette">
        <p className="small quiet">Вставка в выбранную точку исходника</p>
        {(["statement", "condition", "loop"] as const).map((kind) => (
          <button
            key={kind}
            className={"palette-block palette-" + kind}
            disabled={
              !selected ||
              !operations.includes("insert_statement") ||
              stale ||
              historical ||
              inFlight
            }
            onClick={() => {
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
        </div>
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
          />
        ) : (
          <div className="empty-pane">
            <span className="empty-glyph">
              <Icon name="workflow" size={32} />
            </span>
            <h2>
              {analysis?.parseStatus === "invalid"
                ? "Исправьте исходник"
                : "Схема появится здесь"}
            </h2>
            <p>
              {analysis?.parseStatus === "invalid"
                ? "Диагностика доступна во вкладке «Вывод»."
                : "Импортируйте .java или выберите метод."}
            </p>
            {!revision && (
              <button onClick={() => importInput.current?.click()}>
                Импорт .java
              </button>
            )}
          </div>
        )}
      </section>
    ),
    code: (
      <section className="code-pane" aria-label="Java редактор">
        <div className="editor-caption">
          <span>{file || "ИСХОДНИК"}</span>
          <span>
            {historical ? "Только чтение" : "JAVA"}
            <button
              onClick={() => void save()}
              disabled={!dirty || saving || conflict || historical}
              title="Ctrl+S"
            >
              {saving ? "Сохранение…" : "Сохранить"}
            </button>
          </span>
        </div>
        {file ? (
          <CodeEditor
            onReady={(commands) => {
              editorCommands.current = commands;
            }}
            path={projectId + "/" + file}
            value={files[file] ?? ""}
            onChange={edit}
            range={
              range &&
              !dirty &&
              analysis?.revisionId === revision?.id &&
              analysis?.parseStatus === "valid"
                ? { ...range, filePath: projectId + "/" + range.filePath }
                : null
            }
            diagnostics={(analysis?.diagnostics ?? []).map((d) => ({
              ...d,
              sourceRange: d.sourceRange
                ? {
                    ...d.sourceRange,
                    filePath: projectId + "/" + d.sourceRange.filePath,
                  }
                : null,
            }))}
            onOffset={offset}
            readOnly={historical || busy || loadingRevision}
          />
        ) : (
          <div className="empty-pane">
            <p>Исходник не загружен</p>
          </div>
        )}
      </section>
    ),
    analysis: (
      <aside className="inspector">
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
            {symbolPanel}
            {operations.length > 0 ? (
              <div className="expression-form">
                <label htmlFor="node-operation">Действие</label>
                <select
                  id="node-operation"
                  value={operation}
                  disabled={inFlight || stale || historical}
                  onChange={(e) => setOperation(e.target.value)}
                >
                  {operations.map((op) => (
                    <option key={op} value={op}>
                      {operationLabels[op]}
                    </option>
                  ))}
                </select>
                {operation === "replace_expression" && editRange(selected) && (
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
                      disabled={inFlight || stale || historical}
                    />
                  </>
                )}
                {operation === "insert_statement" && (
                  <>
                    <label htmlFor="insert-position">Позиция</label>
                    <select
                      id="insert-position"
                      value={position}
                      disabled={inFlight || stale || historical}
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
                      disabled={inFlight || stale || historical}
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
                      disabled={inFlight || stale || historical}
                      onChange={(e) => setStatement(e.target.value)}
                    />
                  </>
                )}
                {operation === "delete_statement" && (
                  <p className="small quiet">Удаление выбранного оператора</p>
                )}
                <label htmlFor="change-intent">Цель изменения</label>
                <select
                  id="change-intent"
                  value={intent}
                  disabled={inFlight || stale || historical}
                  onChange={(e) => setIntent(e.target.value)}
                >
                  <option value="semantic_edit">Изменить логику</option>
                  <option value="preserve_behavior">Сохранить поведение</option>
                </select>
                <button
                  className="primary wide"
                  disabled={
                    inFlight ||
                    stale ||
                    historical ||
                    !operations.includes(operation) ||
                    (operation === "replace_expression" &&
                      (!editRange(selected) || !expression.trim())) ||
                    (operation === "insert_statement" &&
                      (!positions.includes(position) || !statement.trim()))
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

        {!selected && symbolPanel}
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
      </aside>
    ),
    console: (
      <div className="dock-content">
        <>
          {analysis?.diagnostics.map((d) => (
            <button
              className="diagnostic"
              key={d.id}
              onClick={() => {
                if (d.sourceRange) {
                  setRange(d.sourceRange);
                  setFile(d.sourceRange.filePath);
                  setMode("split");
                }
              }}
            >
              <span className="diagnostic-symbol">
                {d.severity === "error" ? "!" : "△"}
              </span>
              <span>{d.message}</span>
              <code>
                {d.sourceRange
                  ? `${d.sourceRange.filePath}:${d.sourceRange.startLine}`
                  : d.code}
              </code>
            </button>
          ))}
          {report ? (
            <ReportView report={report} projectId={projectId} />
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
        {report?.testResults ? (
          <ReportView report={report} projectId={projectId} />
        ) : (
          <div className="output-empty">
            <span className="terminal-prompt">
              <Icon name="compare" size={17} />
            </span>
            <span>Нет сравнений</span>
            <button
              onClick={() => setDialog("compare")}
              disabled={!revision || dirty}
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
                    : proposal.status}
                </span>
              </span>
              <span className="small quiet">
                {proposal.intent === "semantic_edit"
                  ? "Изменение логики"
                  : "Сохранение поведения"}
              </span>
              <button
                className="primary"
                disabled={
                  inFlight ||
                  historical ||
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
              <button disabled={busy} onClick={() => setProposal(null)}>
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
            {proposal.checks && (
              <p className="small quiet">
                Разбор: {proposal.checks.parseStatus} · Компиляция:{" "}
                {proposal.checks.compileStatus} · Проверка поведения:{" "}
                {proposal.checks.verificationStatus}
              </p>
            )}
            {proposal.intent === "preserve_behavior" &&
              proposal.candidateRevisionId && (
                <button onClick={() => setDialog("compare")}>
                  Проверить base / candidate
                </button>
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
    if (job && ["queued", "running"].includes(job.status))
      void api<Job>(base + "/jobs/" + job.id + "/cancel", {
        method: "POST",
        body: {},
      })
        .then(setJob)
        .catch((e) => setError(message(e)));
  }
  return (
    <div className="workbench configurable-workbench">
      <header className="toolbar">
        <Brand />
        <WorkspaceMenu
          workspace={workspace}
          actions={{
            save: () => void save(),
            import: () => importInput.current?.click(),
            export: () => void exportRevision(),
            projects: () => navigate("/"),
            run: () => setDialog("run"),
            compare: () => setDialog("compare"),
            stop: stopJob,
            edit: (command) => {
              void workspace.reveal("code").then(() => {
                if (mounted.current) editorCommands.current?.[command]();
              });
            },
            editDisabled: !file || historical || busy || loadingRevision,
            saveDisabled: !dirty || saving || conflict || historical,
            runDisabled: !revision || dirty || busy,
            exportDisabled: !revision || busy,
            importDisabled: busy,
            stopDisabled: !job || !["queued", "running"].includes(job.status),
          }}
        />
        <a
          className="project-title"
          href={"/projects/" + projectId}
          onClick={(e) => {
            e.preventDefault();
            navigate("/projects/" + projectId);
          }}
        >
          {project?.name ?? "Проект"}
        </a>
        <span className="version-badge" title={revision?.bundleHash}>
          {short(revision?.id)}
        </span>
        <span className="toolbar-spacer" />
        <button
          className={
            "layout-configure " + (workspace.editing ? "selected" : "")
          }
          onClick={() => workspace.setEditing(!workspace.editing)}
          aria-pressed={workspace.editing}
        >
          Расположение
        </button>
        <ThemeToggle />
        <button onClick={() => importInput.current?.click()} disabled={busy}>
          <Icon name="upload" /> <span className="hide-narrow">Импорт</span>
        </button>
        <button
          onClick={() => setDialog("run")}
          disabled={!revision || dirty || busy}
        >
          <Icon name="play" /> Запуск
        </button>
        <button
          className="icon-button"
          title="Остановить выполнение"
          aria-label="Остановить выполнение"
          disabled={!job || !["queued", "running"].includes(job.status)}
          onClick={stopJob}
        >
          ■
        </button>
        <button
          className="primary"
          onClick={() => setDialog("compare")}
          disabled={!revision || dirty || busy}
        >
          <Icon name="compare" /> Сравнить
        </button>
        <button
          className="icon-button"
          title="Экспорт выбранной версии"
          aria-label="Экспорт выбранной версии"
          onClick={() => void exportRevision()}
          disabled={!revision || busy}
        >
          <Icon name="download" />
        </button>
        <input
          type="file"
          multiple
          accept=".java"
          ref={importInput}
          hidden
          onChange={(e) => void importFiles(e.target.files)}
        />
      </header>
      <main className="workbench-body">
        <div className="workbench-context">
          <span>
            {file || "Нет файлов"}
            {method ? " / " + method.signature.split("(")[0] : ""}
          </span>
          <span className="small quiet">
            {job ? labelStatus(job.status) + " · " + short(job.id) : "Java 21"}
          </span>
        </div>
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
        <Workspace controller={workspace} panels={panels} />
      </main>
      <footer className="statusbar">
        <span className={"connection-dot " + (dirty ? "unsaved" : "")} />
        <span role="status" aria-live="polite">
          {saving ? "Сохранение…" : dirty ? "Есть локальные изменения" : status}
        </span>
        <span className="toolbar-spacer" />
        <span>
          {analysis?.parseStatus === "valid"
            ? "✓ Разобрано"
            : analysis
              ? labelStatus(analysis.parseStatus)
              : ""}
        </span>
        <span>UTF-8</span>
        <span>LF</span>
        <span>Java 21</span>
      </footer>
      {dialog && project && revision && (
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
  const [baseRevision, setBaseRevision] = useState(
    proposal?.baseRevisionId ?? project.originalRevisionId ?? revision.id,
  );
  const [candidate, setCandidate] = useState(
    proposal?.candidateRevisionId ?? revision.id,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const focus = useRef<HTMLInputElement>(null);
  useEffect(() => {
    focus.current?.focus();
  }, []);
  async function submit() {
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
          method: "POST",
          body: {
            revisionId: revision.id,
            entryPoint: entry.trim(),
            argv: args,
            stdinUtf8: stdin,
            profileId: "java21-v1",
          },
        });
      } else {
        const parsed: unknown = JSON.parse(cases);
        if (!Array.isArray(parsed) || parsed.length === 0)
          throw new Error("Добавьте хотя бы один вход.");
        const suite = await api<{ id: string }>(
          projectPath(project.id) + "/test-suites",
          {
            method: "POST",
            body: {
              mode: "console",
              entryPoint: entry.trim(),
              cases: parsed,
              comparisonPolicyId: "exact-v1",
            },
          },
        );
        j = await api<Job>(projectPath(project.id) + "/comparisons", {
          method: "POST",
          body: {
            baseRevisionId: baseRevision,
            candidateRevisionId: candidate,
            suiteVersionId: suite.id,
            profileId: "java21-v1",
          },
        });
      }
      onStart(j);
    } catch (e) {
      const msg = message(e);
      setError(msg);
      onError(msg);
    } finally {
      setBusy(false);
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
              "button:not(:disabled),input,textarea,select",
            );
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
                      {r.id === project.originalRevisionId ? " · исходная" : ""}
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
            <label htmlFor="test-cases">Входные данные · JSON cases</label>
            <textarea
              id="test-cases"
              className="test-cases"
              rows={9}
              value={cases}
              onChange={(e) => setCases(e.target.value)}
              spellCheck={false}
            />
            <p className="small quiet">
              Точные stdout, stderr и код завершения. По 3 наблюдения каждой
              версии на вход. Совпадение относится только к этому набору.
            </p>
          </>
        )}
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
            disabled={busy}
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
}: {
  report: Report;
  projectId: string;
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
              {report.matched ?? 0} из {report.total} входов
            </span>
          )}
          <span className="small">
            {report.baseRevisionId &&
              `${short(report.baseRevisionId)} → ${short(report.candidateRevisionId)}`}
          </span>
        </div>
      )}
      {report.inconclusiveReasons?.length ? (
        <p>{report.inconclusiveReasons.join(" · ")}</p>
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
                  inconclusive: "Не завершено",
                  not_run: "Не запущено",
                } as Record<string, string>
              )[t.verdict] ?? t.verdict}
            </span>
            <small>
              {t.baseExecutions?.length ?? 0} +{" "}
              {t.candidateExecutions?.length ?? 0} наблюдений
            </small>
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
          {(t.reasons?.length ?? 0) > 0 && <p>{t.reasons?.join(" · ")}</p>}
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
