import AssistantHost from "./AssistantHost";
import { registerAssistantWorkspace } from "./assistantBridge";
import type { AssistantWorkspace } from "./assistantBridge";
import { searchProject } from "./searchIndex";
import ReportDownloads from "./ReportDownloads";
import ImportReview from "./ImportReview";
import type { ImportTree } from "./ImportReview";
import { isSaveShortcut } from "./shortcuts";
import ProjectSearch from "./ProjectSearch";
import GuidedTour, { TargetSpotlight } from "./Spotlight";
import TourButton from "./TourButton";
import GitHubSettings from "./GitHubSettings";
import GitHubLoginButton from "./GitHubLoginButton";
import GitHubSignup from "./GitHubSignup";
import { authReturn, consumeAuthReturn } from "./authNavigation";
import GitHubImport from "./GitHubImport";
import type { SearchHit } from "./searchIndex";
import "./workspaceUX.css";
import Select from "./Select";
import ProjectAccess from "./ProjectAccess";
import {
  AccountProvider,
  AccountNav,
  ProductSidebar,
  useAccount,
  canCreateProjects,
  canExportProjects,
} from "./Account";
import AccountAuth from "./AccountAuth";
import Avatar from "./Avatar";
import ProfilePage from "./ProfilePage";
import SettingsPage from "./SettingsPage";
import FriendsPage from "./FriendsPage";
import SingleRunOutput from "./SingleRunOutput";
import TestProgressView from "./TestProgressView";
import CodeInsights from "./CodeInsights";
import useFileRuns from "./useFileRuns";
import TestCasesEditor from "./TestCasesEditor";
import {
  CompileErrorHelp,
  SourceFilenameIssues,
  useRunSources,
} from "./RunSourceCheck";
import { parseCases } from "./testCases";
import { readPrepared, writePrepared, clearPrepared } from "./preparedProposal";
import { useProjectList } from "./useProjectList";
import "./projectList.css";
import { testDuration, testReason } from "./testProgress";
import LiveConsole from "./LiveConsole";

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
import {
  extractionTargets,
  extractionFromSelection,
  validMethodName,
  validClassName,
} from "./methodExtraction";
import CodeEditor, { disposeEditorModels } from "./CodeEditor";
import ExecutionResources from "./ExecutionResources";
import ProjectArchives from "./ProjectArchives";
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
  javaFilenameIssues,
  javaEntryHint,
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
  overview?: boolean;
  methodSelections?: Record<string, ReturnType<typeof methodIdentity>>;
}
function readView(id: string): Partial<WorkbenchView> {
  try {
    const view = JSON.parse(
      localStorage.getItem("java-blueprints:view:" + id) ?? "{}",
    );
    return {
      overview: typeof view?.overview === "boolean" ? view.overview : true,
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
      href="/projects"
      onClick={(e) => {
        e.preventDefault();
        navigate("/projects");
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
  return (
    <>
      <RouteContent path={path} />
      <AssistantHost />
      {!/^\/(?:auth\/)?(?:login|register|forgot-password|reset-password|verify-email)\/?$/.test(
        path,
      ) &&
        path !== "/" &&
        path !== "/github/complete" && <GuidedTour path={path} />}
    </>
  );
}
function RouteContent({ path }: { path: string }) {
  const { session, loading, error, refresh } = useAccount();
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
  const signup = path === "/github/complete";
  const isAuth = !!authMode || signup;
  const publicProfile = /^\/(?:u|profile)\/[^/]+(?:\/friends)?\/?$/.test(path);
  const needsLogin = !isAuth && !match && !publicProfile && !session?.user;
  const signedInAuth =
    !!session?.user &&
    (signup || authMode === "login" || authMode === "register");
  useEffect(() => {
    if (loading || error) return;
    let destination: string | undefined;
    if (needsLogin)
      destination =
        "/login" +
        (path === "/"
          ? ""
          : "?next=" + encodeURIComponent(path + location.search));
    else if (signedInAuth)
      destination = signup ? consumeAuthReturn() : authReturn();
    else if (
      session?.user &&
      path === "/projects" &&
      ["login_success", "signup_success"].includes(
        new URLSearchParams(location.search).get("github") ?? "",
      )
    )
      destination = consumeAuthReturn();
    if (destination !== undefined) {
      if (destination === "/" || destination.startsWith("/?")) {
        location.replace(destination);
        return;
      }
      history.replaceState({}, "", destination);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [
    loading,
    error,
    needsLogin,
    signedInAuth,
    path,
    signup,
    session?.user?.id,
  ]);
  if ((loading && !isAuth) || needsLogin || signedInAuth)
    return (
      <div className="auth-entry-status" role="status">
        {error ? (
          <>
            <p>{error}</p>
            <button onClick={() => void refresh()}>Повторить</button>
          </>
        ) : (
          "Загрузка…"
        )}
      </div>
    );
  if (signup) return <GitHubSignup />;
  if (match && !session?.user)
    return (
      <PublicProjectEntry
        key={match[1]}
        projectId={match[1]}
        runId={match[2]}
      />
    );
  if (authMode)
    return (
      <AccountAuth
        key={authMode}
        mode={authMode}
        githubLogin={
          authMode === "login" || authMode === "register" ? (
            <GitHubLoginButton />
          ) : undefined
        }
      />
    );
  const section = path.match(
    /^\/settings(?:\/(profile|security|appearance|friends|integrations))?\/?$/,
  );
  if (section || path === "/account")
    return (
      <SettingsPage
        section={
          (section?.[1] ?? "profile") as
            "profile" | "security" | "appearance" | "friends" | "integrations"
        }
        integrations={<GitHubSettings />}
      />
    );
  if (path === "/friends") return <FriendsPage />;
  const profileFriends = path.match(/^\/(?:u|profile)\/([^/]+)\/friends\/?$/);
  if (profileFriends) {
    let username = profileFriends[1];
    try {
      username = decodeURIComponent(username);
    } catch {}
    return <FriendsPage key={username} username={username} />;
  }
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
function PublicProjectEntry({
  projectId,
  runId,
}: {
  projectId: string;
  runId?: string;
}) {
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const requireLogin = () => {
      history.replaceState(
        {},
        "",
        "/login?next=" +
          encodeURIComponent(location.pathname + location.search),
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    setError("");
    api<Project>(projectPath(projectId), { signal: controller.signal })
      .then((project) => {
        if (controller.signal.aborted) return;
        if (project.visibility === "public") setAllowed(true);
        else requireLogin();
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
          requireLogin();
        else setError(message(cause));
      });
    return () => controller.abort();
  }, [projectId, retry]);
  if (allowed) return <Workbench projectId={projectId} runId={runId} />;
  return (
    <div className="auth-entry-status" role="status">
      {error ? (
        <>
          <p>{error}</p>
          <button onClick={() => setRetry((value) => value + 1)}>
            Повторить
          </button>
        </>
      ) : (
        "Открываем проект…"
      )}
    </div>
  );
}
function Projects() {
  const { session } = useAccount();
  const mayCreate = canCreateProjects(session);
  const legacyAvailable = session?.capabilities.legacyGuestWorkspace === true;
  const [scope, setScope] = useState<"account" | "legacy">("account");
  const list = useProjectList(
    scope === "legacy" && legacyAvailable ? "legacy" : undefined,
    session?.user?.id,
    mayCreate,
  );
  const projects = list.rows,
    loading = list.loading;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [githubChooser, setGithubChooser] = useState(false);
  const [homePreview, setHomePreview] = useState<ImportTree | null>(null);
  const homeRequest = useRef<{
    projectKey: string;
    revisionKey: string;
    name: string;
    projectId?: string;
    tree: ImportTree;
  } | null>(null);
  const creatingImport = useRef(false),
    homeActive = useRef(true);
  const homeEpoch = useRef(0),
    homeController = useRef<AbortController | null>(null);
  useEffect(() => {
    homeEpoch.current++;
    homeController.current?.abort();
    homeRequest.current = null;
    creatingImport.current = false;
    setBusy(false);
    setGithubChooser(false);
    setHomePreview(null);
  }, [session?.user?.id]);
  useEffect(() => {
    homeActive.current = true;
    return () => {
      homeActive.current = false;
      homeEpoch.current++;
      homeController.current?.abort();
    };
  }, []);
  async function createFromGitHub(preview: ImportTree) {
    if (!mayCreate || creatingImport.current) return;
    creatingImport.current = true;
    const epoch = homeEpoch.current,
      controller = new AbortController();
    homeController.current = controller;
    const current = () =>
      homeActive.current &&
      homeEpoch.current === epoch &&
      !controller.signal.aborted;
    setBusy(true);
    setError("");
    const request = homeRequest.current ?? {
      projectKey: crypto.randomUUID(),
      revisionKey: crypto.randomUUID(),
      name: name.trim() || "GitHub project",
      tree: preview,
    };
    homeRequest.current = request;
    try {
      if (!request.projectId) {
        const p = await api<Project>("/projects", {
          method: "POST",
          key: request.projectKey,
          signal: controller.signal,
          body: { name: request.name },
        });
        request.projectId = p.id;
      }
      if (!current()) return;
      await api<Revision>(projectPath(request.projectId) + "/revisions", {
        method: "POST",
        key: request.revisionKey,
        signal: controller.signal,
        head: null,
        body: {
          files: request.tree.files,
          directories: request.tree.directories,
          importedPaths: request.tree.files.map((f) => f.path),
          importedDirectories: request.tree.directories,
        },
      });
      if (current()) navigate("/projects/" + request.projectId);
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) {
        creatingImport.current = false;
        setBusy(false);
      }
      if (homeController.current === controller) homeController.current = null;
    }
  }
  async function create(sample = false, files?: FileList | null) {
    if (!mayCreate || creatingImport.current) return;
    creatingImport.current = true;
    const ticket = homeEpoch.current;
    const controller = new AbortController();
    homeController.current = controller;
    const current = () =>
      homeActive.current &&
      ticket === homeEpoch.current &&
      !controller.signal.aborted;
    setBusy(true);
    setError("");
    try {
      const p = await api<Project>("/projects", {
        method: "POST",
        signal: controller.signal,
        body: {
          name:
            name.trim() ||
            (sample
              ? "Поиск в массиве"
              : files?.[0]?.name.replace(/\.java$/, "") || "Новый проект"),
        },
      });
      if (!current()) return;
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
          signal: controller.signal,
          head: null,
          body: data,
        });
      }
      if (current()) navigate("/projects/" + p.id);
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) {
        creatingImport.current = false;
        setBusy(false);
      }
      if (homeController.current === controller) homeController.current = null;
    }
  }
  if (session && !mayCreate)
    return (
      <div className="projects-page">
        <ProductSidebar active="/projects" />
        <header className="home-header">
          <AccountNav />
        </header>
        <main className="project-main">
          <div className="project-heading">
            <h1>
              Ваше рабочее пространство<span className="lime-dot">.</span>
            </h1>
          </div>
          <p className="quiet">
            Войдите, чтобы создавать проекты, сохранять изменения и запускать
            Java.
          </p>
          <div className="github-actions">
            <a className="primary" href="/login">
              Войти
            </a>
            <a href="/register">Создать аккаунт</a>
          </div>
        </main>
      </div>
    );
  return (
    <div className="projects-page">
      <ProductSidebar active="/projects" />
      <header className="home-header">
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
            disabled={busy || !mayCreate}
          >
            <Icon name="upload" /> Импорт .java
          </button>
        </div>
        {session?.user && legacyAvailable && (
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
        {githubChooser && (
          <div className="modal-backdrop">
            <section
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="Импорт из GitHub"
            >
              <button
                disabled={busy}
                onClick={() => {
                  setGithubChooser(false);
                  setHomePreview(null);
                  homeRequest.current = null;
                }}
              >
                Закрыть
              </button>
              {homePreview ? (
                <ImportReview
                  key={homeRequest.current?.projectKey ?? "preview"}
                  preview={homeRequest.current?.tree ?? homePreview}
                  busy={busy}
                  locked={!!homeRequest.current}
                  onBack={() => {
                    if (homeRequest.current) {
                      setError(
                        "Повторите подтверждённый импорт; проект уже мог быть создан.",
                      );
                      return;
                    }
                    setHomePreview(null);
                  }}
                  onConfirm={(preview) => void createFromGitHub(preview)}
                />
              ) : (
                <GitHubImport
                  onPreview={(preview) => {
                    homeRequest.current = null;
                    setHomePreview(preview);
                  }}
                />
              )}
              {error && <p role="alert">{error}</p>}
            </section>
          </div>
        )}
        <button
          className="github-project-import"
          disabled={busy || !mayCreate}
          onClick={() => setGithubChooser(true)}
        >
          Импорт из GitHub
        </button>
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
          <button onClick={() => void create()} disabled={busy || !mayCreate}>
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
          disabled={busy || !mayCreate}
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
  const [overview, setOverview] = useState(initialView.overview ?? true);
  const [focusNode, setFocusNode] = useState<{
    id: string;
    request: number;
  } | null>(null);
  const [spotlight, setSpotlight] = useState<Element | null>(null);
  const [githubImport, setGithubImport] = useState(false);
  const [wideMenu, setWideMenu] = useState(
    () => matchMedia("(min-width:981px)").matches,
  );
  const [menuExpanded, setMenuExpanded] = useState(false);
  useEffect(() => {
    const query = matchMedia("(min-width:981px)");
    const update = () => setWideMenu(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [requestedMethodId, setMethodId] = useState(initialView.methodId ?? "");
  const fileMethods =
    graph?.methods.filter((m) => m.sourceRange.filePath === file) ?? [];
  const methodId =
    fileMethods.find((m) => m.id === requestedMethodId)?.id ??
    matchingMethod(fileMethods, methodSelections.current[file])?.id ??
    fileMethods[0]?.id ??
    "";
  const [selectedNode, setSelected] = useState<GraphNode | null>(null);
  const selected =
    selectedNode?.methodId === methodId &&
    (!selectedNode.sourceRange || selectedNode.sourceRange.filePath === file)
      ? selectedNode
      : null;
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
  const fileRuns = useFileRuns(projectId, file, job);
  const runJob = fileRuns.run;
  const testJob = fileRuns.comparison;
  const runReport = runJob?.result?.report;
  const testReport = testJob?.result?.report;
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const proposalEpoch = useRef(0);
  const restoredProposal = useRef<string | null>(null);
  const [loadingRevision, setLoadingRevision] = useState(true);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const [operation, setOperation] = useState("");
  const [insertionPreview, setInsertionPreview] = useState<{
    nodeId: string;
    request: number;
  } | null>(null);
  const insertionPreviewSequence = useRef(0);
  function previewInsertion(nodeId: string | undefined) {
    if (nodeId)
      setInsertionPreview({
        nodeId,
        request: ++insertionPreviewSequence.current,
      });
  }
  const [position, setPosition] = useState("");
  const [template, setTemplate] = useState("statement");
  const [statement, setStatement] = useState(statementTemplates.statement);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [movePosition, setMovePosition] = useState("before");
  const [extractedMethodName, setExtractedMethodName] =
    useState("extractedMethod");
  const [renamedLocalName, setRenamedLocalName] = useState("renamedValue");
  const [extractedClassName, setExtractedClassName] =
    useState("ExtractedLogic");
  const [extractionEndNodeId, setExtractionEndNodeId] = useState("");
  const [extractionEdit, setExtractionEdit] = useState<{
    nodeId: string;
    endNodeId: string;
    serial: number;
  } | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const handledExtraction = useRef<number | null>(null);
  const extractionSequence = useRef(0);
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
          overview,
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
  }, [projectId, file, methodId, tabs, overview]);
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
  useEffect(() => {
    if (selectedNode && selectedNode.methodId !== methodId) setSelected(null);
    setReferenceId((id) =>
      analysis?.semantics?.references.some(
        (r) => r.id === id && r.sourceRange.filePath === file,
      )
        ? id
        : null,
    );
    setRange((old) => (old?.filePath === file ? old : null));
  }, [file, methodId]);
  useEffect(() => {
    setExtractionEdit(null);
    setExtractionEndNodeId("");
    setSelectionNotice("");
  }, [file]);
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
      return r;
    } catch (e) {
      if (mounted.current && openId === openGeneration.current)
        setError(message(e));
    } finally {
      if (mounted.current && openId === openGeneration.current)
        setLoadingRevision(false);
    }
  }
  async function openRunSource(id: string, path: string) {
    if (
      busy ||
      saving ||
      loadingRevision ||
      (job && ["queued", "running"].includes(job.status))
    )
      return;
    if (dirty) {
      setError(
        "Сначала сохраните локальный черновик. Ошибка отчёта относится к сохранённой версии.",
      );
      return;
    }
    setDialog(null);
    const snapshot = revision?.id === id ? revision : await openRevision(id);
    if (
      !snapshot ||
      !mounted.current ||
      !snapshot.files.some((file) => file.path === path)
    )
      return;
    setFile(path);
    setRange(null);
    void workspace.reveal("code");
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
      if (isSaveShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        downloadDraft();
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
      if (
        e.key === "Escape" &&
        !(e.target as Element)?.closest?.('[role="listbox"]')
      ) {
        setDialog(null);
        workspace.setMaximized(null);
      }
    };
    // Capture Save before Monaco handles it and stops the event bubbling.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [save, dirty, accessReadOnly, file, files]);
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
    ? references.find(
        (r) => r.id === referenceId && r.sourceRange.filePath === file,
      )
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
  function chooseSearch(hit: SearchHit) {
    if (!Object.hasOwn(files, hit.file)) return;
    setFile(hit.file);
    setRange(hit.range ?? null);
    setReferenceId(null);
    if (hit.methodId) setMethodId(hit.methodId);
    if (hit.nodeId && !stale) {
      const n = graph?.nodes.find((n) => n.id === hit.nodeId);
      if (n) pickNode(n);
      setFocusNode({ id: hit.nodeId, request: Date.now() });
      void workspace.revealMany(["graph", "code"]).then(() =>
        requestAnimationFrame(() => {
          const node = Array.from(
            document.querySelectorAll("[data-node-id]"),
          ).find((el) => el.getAttribute("data-node-id") === hit.nodeId);
          if (node) setSpotlight(node);
        }),
      );
    } else {
      setSelected(null);
      if (hit.kind === "file") setOverview(true);
      else if (hit.kind === "method") setOverview(false);
      void workspace.reveal(hit.kind === "method" ? "graph" : "code");
    }
  }
  function pickNode(n: GraphNode) {
    if (stale || busy || saving || loadingRevision) return;
    setInspectorFocus((value) => value + 1);
    setSelected(n);
    setMethodId(n.methodId);
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
  const extractionEnds = extractionTargets(selected, graph);
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
    newName: renamedLocalName,
    className: extractedClassName,
    methodName: extractedMethodName,
    endNodeId: extractionEndNodeId,
  });
  useEffect(() => {
    proposalEpoch.current++;
    setInsertionPreview(null);
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
    setExtractionEndNodeId(selected?.id ?? "");
    setTargetNodeId("");
    setMovePosition("before");
    setWrapCondition("");
    setElseSource("{\n\n}");
    setProposal(null);
    if (dropEdit && dropEdit.nodeId === selected?.id) {
      previewInsertion(selected.id);
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
    if (
      extractionEdit &&
      extractionEdit.serial !== handledExtraction.current &&
      extractionEdit.nodeId === selected?.id &&
      selected?.allowedOperations?.includes("extract_method")
    ) {
      setOperation("extract_method");
      setIntent("preserve_behavior");
      setExtractionEndNodeId(extractionEdit.endNodeId);
      handledExtraction.current = extractionEdit.serial;
    }
  }, [
    selected?.id,
    revision?.id,
    dropEdit?.serial,
    optimizationEdit?.serial,
    extractionEdit?.serial,
  ]);
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
    extractedMethodName,
    extractedClassName,
    renamedLocalName,
    extractionEndNodeId,
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
          intent: [
            "optimize_membership",
            "extract_method",
            "decompose_class",
            "rename_local",
          ].includes(operation)
            ? "preserve_behavior"
            : intent,
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
  async function repeatJob(previous: Job) {
    if (
      accessReadOnly ||
      busy ||
      ["queued", "running"].includes(previous.status)
    )
      return;
    setBusy(true);
    setError("");
    try {
      const next = await api<Job>(base + "/runs/" + previous.id + "/repeat", {
        method: "POST",
      });
      if (!mounted.current) return;
      setJob(next);
      setDock(next.type === "compare" ? "tests" : "output");
      navigate(`/projects/${projectId}/runs/${next.id}`);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function rerunButton(previous: Job | null | undefined) {
    return previous && !["queued", "running"].includes(previous.status) ? (
      <button
        className="rerun-button"
        disabled={accessReadOnly || busy || runnerAvailable === false}
        onClick={() => void repeatJob(previous)}
        title="Повторить сохранённую версию и параметры. Ответы интерактивной программе вводятся заново."
      >
        <Icon name="play" size={14} />
        Запустить снова <small>{short(previous.revisionId)}</small>
      </button>
    ) : null;
  }
  async function exportRevision(paths?: string[]) {
    if (!revision) return;
    if (
      paths?.length === 1 &&
      revision.files.some((f) => f.path === paths[0])
    ) {
      const a = document.createElement("a");
      a.href =
        "/api/v1" +
        base +
        "/revisions/" +
        revision.id +
        "/download?path=" +
        encodeURIComponent(paths[0]);
      a.download = paths[0].split("/").pop()!;
      a.click();
      return;
    }
    if (!canExportProjects(accountSession)) {
      setError("Войдите в аккаунт, чтобы скачать ZIP проекта.");
      return;
    }
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
    if (!file || !(file in files)) return;
    const a = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([files[file] ?? ""], { type: "text/plain" }),
    );
    a.href = url;
    a.download = file.split("/").pop() ?? "Main.java";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const assistantWorkspace = useRef<AssistantWorkspace | null>(null);
  assistantWorkspace.current = {
    context: () => ({
      projectId,
      projectName: project?.name,
      revisionId: revision?.id,
      filePath: file,
      methodId,
      methodName: method?.signature,
      entryPoint: javaEntryHint(
        revision?.files.find((source) => source.path === file),
      ),
      testJobId: testJob?.id,
      runJobId: runJob?.id,
      dirty,
      readonly: accessReadOnly,
    }),
    execute: async (command) => {
      if (!project || !revision || loadingRevision)
        return { ok: false, message: "Проект ещё загружается." };
      if (command.args.projectId && command.args.projectId !== projectId)
        return {
          ok: false,
          message: "Открыт другой проект. Запросите действие снова.",
        };
      if (
        ["run_tests", "run_program", "workspace_action", "optimize"].includes(
          command.type,
        ) &&
        ((command.args.revisionId && command.args.revisionId !== revision.id) ||
          (command.args.filePath && command.args.filePath !== file) ||
          (command.args.methodId && command.args.methodId !== methodId))
      )
        return {
          ok: false,
          message:
            "Выбранный файл, метод или версия изменились. Запросите действие снова.",
        };
      if (command.type === "show_panel") {
        const aliases: Record<string, string> = {
          files: "project",
          optimization: "analysis",
          diff: "changes",
        };
        const name = String(command.args.panel);
        if (name === "search") {
          searchInput.current?.focus();
          return { ok: true, message: "Поиск по проекту открыт." };
        }
        const panel = aliases[name] ?? name;
        if (
          ![
            "code",
            "graph",
            "tests",
            "console",
            "analysis",
            "project",
            "changes",
            "history",
          ].includes(panel)
        )
          return { ok: false, message: "Неизвестная панель." };
        await workspace.reveal(panel as "code");
        if (name === "optimization")
          window.dispatchEvent(
            new CustomEvent("java-blueprints:assistant-analysis-tab", {
              detail: { tab: "recommendations" },
            }),
          );
        return { ok: true, message: "Панель открыта: " + name };
      }
      if (command.type === "find_symbol") {
        const query = String(command.args.query ?? "").trim();
        if (!query || query.length > 120)
          return { ok: false, message: "Уточните имя для поиска." };
        const results = searchProject(files, stale ? null : graph, query);
        if (!results.length)
          return {
            ok: false,
            message: "В открытом проекте совпадений не найдено.",
          };
        const hit = results[0];
        chooseSearch(hit);
        window.dispatchEvent(
          new CustomEvent("java-blueprints:assistant-minimize"),
        );
        setTimeout(() => {
          const target = Array.from(
            document.querySelectorAll<HTMLElement>(
              hit.kind === "method" ? ".method-item" : "[data-file-path]",
            ),
          ).find((el) =>
            hit.kind === "method"
              ? el.textContent?.includes(hit.title)
              : el.getAttribute("data-file-path") === hit.file,
          );
          if (target) {
            target.scrollIntoView({ block: "nearest", behavior: "smooth" });
            setSpotlight(target);
          }
        }, 160);
        return {
          ok: true,
          message: `Найдено ${results.length}. Открыто: ${hit.title} · ${hit.file}.`,
        };
      }
      if (command.type === "workspace_action") {
        const action = String(command.args.action);
        if (accessReadOnly || busy || loadingRevision)
          return {
            ok: false,
            message:
              "Действие недоступно: нужен доступ к редактированию и свободный редактор.",
          };
        window.dispatchEvent(
          new CustomEvent("java-blueprints:assistant-minimize"),
        );
        if (action === "create_file" || action === "create_folder") {
          await workspace.reveal("project");
          setCreateCommand({
            kind: action === "create_file" ? "file" : "folder",
            id: Date.now(),
          });
          return {
            ok: true,
            message:
              "Открыта форма создания. Введите имя и нажмите Enter; файл или папка ещё не созданы.",
          };
        }
        if (action === "import") {
          setImportChooser(true);
          return {
            ok: true,
            message:
              "Открыт импорт. Выберите источник и файлы, затем подтвердите импорт.",
          };
        }
        if (action === "run_settings" || action === "test_settings") {
          setDialog(action === "run_settings" ? "run" : "compare");
          return {
            ok: true,
            message: "Открыты параметры. Выполнение ещё не началось.",
          };
        }
        if (action === "save_code") {
          const ok = await save();
          return {
            ok: !!ok,
            message: ok
              ? "Код проекта сохранён."
              : "Код не сохранён. Проверьте сообщение редактора.",
          };
        }
        if (action === "save_layout" || action === "base_layout") {
          await workspace.saveLayout(action === "base_layout");
          return {
            ok: true,
            message: "Расположение сохранено в этом браузере.",
          };
        }
        if (action === "restore_layout") {
          await workspace.restoreLayout();
          return { ok: true, message: "Расположение восстановлено." };
        }
        if (action === "stop") {
          if (!job || !["queued", "running"].includes(job.status))
            return {
              ok: false,
              message: "Нет текущего выполняющегося задания для остановки.",
            };
          await api(base + "/runs/" + job.id + "/cancel", { method: "POST" });
          setJob(await api<Job>(base + "/runs/" + job.id));
          return {
            ok: true,
            message:
              "Запрос остановки отправлен. Итоговый статус появится в панели задания.",
          };
        }
        return {
          ok: false,
          message: "Неизвестное действие рабочего пространства.",
        };
      }
      if (
        accessReadOnly ||
        dirty ||
        stale ||
        inFlight ||
        runnerAvailable === false
      )
        return {
          ok: false,
          message:
            "Действие недоступно: сохраните код, дождитесь актуального анализа и завершения текущей операции. Для запуска нужен runner и право редактирования.",
        };
      if (command.type === "run_tests" || command.type === "run_program") {
        const comparison = command.type === "run_tests";
        await workspace.reveal(comparison ? "tests" : "console");
        const previous = comparison ? testJob : runJob;
        if (
          !previous ||
          ["queued", "running"].includes(previous.status) ||
          (previous.revisionId ??
            previous.result?.report?.candidateRevisionId) !== revision.id
        ) {
          window.dispatchEvent(
            new CustomEvent("java-blueprints:assistant-minimize"),
          );
          setDialog(comparison ? "compare" : "run");
          return {
            ok: true,
            message: !comparison
              ? "Открыты параметры запуска текущего файла. Программа ещё не запущена."
              : "Открыты параметры сравнения для текущего файла. Проверьте класс с main, версии и входы. Тесты ещё не запущены.",
          };
        }
        const next = await api<Job>(base + "/runs/" + previous.id + "/repeat", {
          method: "POST",
        });
        setJob(next);
        setDock(comparison ? "tests" : "output");
        navigate(`/projects/${projectId}/runs/${next.id}`);
        return {
          ok: true,
          message:
            (comparison
              ? "Проверка поставлена в очередь: "
              : "Программа поставлена в очередь: ") +
            next.id +
            ". Результат появится в панели тестов; прохождение ещё не подтверждено.",
        };
      }
      if (command.type === "optimize") {
        const opportunity = analysis?.optimizations?.find(
          (op) => op.methodId === methodId,
        );
        const node = graph?.nodes.find(
          (n) =>
            n.id === opportunity?.nodeId &&
            n.allowedOperations?.includes("optimize_membership"),
        );
        if (!node || !analysis) {
          await workspace.reveal("analysis");
          window.dispatchEvent(
            new CustomEvent("java-blueprints:assistant-analysis-tab", {
              detail: { tab: "recommendations" },
            }),
          );
          return {
            ok: false,
            message:
              "Для выбранного метода сервис не нашёл поддерживаемой автоматической оптимизации. Открыт анализ: можно рассмотреть рекомендации и извлечение метода.",
          };
        }
        setBusy(true);
        const epoch = ++proposalEpoch.current;
        try {
          const p = await api<Proposal>(base + "/changes", {
            method: "POST",
            body: {
              baseRevisionId: revision.id,
              analysisId: analysis.id,
              methodId: node.methodId,
              nodeId: node.id,
              operation: "optimize_membership",
              payload: {},
              intent: "preserve_behavior",
            },
          });
          if (!mounted.current || epoch !== proposalEpoch.current)
            return {
              ok: false,
              message: "Контекст изменился. Проверьте историю изменений.",
            };
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
          if (!mounted.current || epoch !== proposalEpoch.current)
            return {
              ok: false,
              message:
                "Контекст изменился. Проверьте подготовленное изменение.",
            };
          setProposal(ready);
          void refreshHistory();
          return {
            ok: final.status !== "failed",
            message:
              final.status === "failed"
                ? "Кандидат не прошёл подготовку. Посмотрите ошибку в изменениях."
                : "Подготовлен отдельный кандидат оптимизации. Исходный код не заменён: просмотрите разницу и сравните версии на тестах перед применением.",
          };
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
      return { ok: false, message: "Команда недоступна в этом контексте." };
    },
  };
  useEffect(
    () =>
      registerAssistantWorkspace({
        context: () => assistantWorkspace.current?.context() ?? {},
        execute: (command) => assistantWorkspace.current!.execute(command),
      }),
    [projectId],
  );
  useEffect(() => {
    const refresh = () => {
      void api<Project>(base)
        .then((p) => {
          if (mounted.current) setProject(p);
        })
        .catch(() => {});
    };
    window.addEventListener(
      "java-blueprints:assistant-project-refresh",
      refresh,
    );
    return () =>
      window.removeEventListener(
        "java-blueprints:assistant-project-refresh",
        refresh,
      );
  }, [base]);
  useEffect(() => {
    for (const [kind, current] of [
      ["comparison", testJob],
      ["run", runJob],
    ] as const) {
      if (!current) continue;
      const outcome = current.result?.report?.outcome;
      window.dispatchEvent(
        new CustomEvent("java-blueprints:assistant-job", {
          detail: {
            kind,
            id: current.id,
            status: current.status,
            outcome,
            message:
              current.status === "cancelled"
                ? "Выполнение отменено."
                : current.status === "failed"
                  ? "Выполнение завершилось ошибкой. Проверьте диагностику."
                  : outcome === "matched_on_tests"
                    ? "Версии совпали на выбранных тестовых входах."
                    : "Выполнение завершено. Проверьте результат и входные данные в панели.",
          },
        }),
      );
    }
  }, [testJob, runJob]);
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
  function resultContext(kind: "run" | "compare", visible?: Job) {
    const other =
      !visible && fileRuns.other?.type === kind ? fileRuns.other : undefined;
    return (
      <>
        <div className="small quiet" data-testid="result-file-context">
          {file || "Выберите файл"}
          {visible?.entryPoint ? ` · ${visible.entryPoint}` : ""}
          {visible?.revisionId ? ` · версия ${short(visible.revisionId)}` : ""}
        </div>
        {fileRuns.resolving && job?.type === kind && (
          <p role="status">Определяем файл запуска…</p>
        )}
        {fileRuns.error && job?.type === kind && (
          <div className="notice error" role="alert">
            {fileRuns.error}{" "}
            <button onClick={fileRuns.retry}>
              Повторить загрузку результата
            </button>
            {job?.result?.report && (
              <details>
                <summary>
                  Результат класса {job.entryPoint} · файл не определён
                </summary>
                <ReportView report={job.result.report} projectId={projectId} />
              </details>
            )}
          </div>
        )}
        {other && (
          <div className="notice" data-testid="other-file-result">
            Последний {kind === "run" ? "запуск" : "прогон тестов"}:{" "}
            {other.path} · {other.entry}.
            <button
              onClick={() => {
                if (Object.hasOwn(files, other.path)) {
                  setFile(other.path);
                  setSelected(null);
                  setRange(null);
                  setReferenceId(null);
                  workspace.reveal("code");
                } else void openRunSource(other.revisionId, other.path);
              }}
            >
              Открыть {other.path}
            </button>
          </div>
        )}
        {(visible?.result?.report?.outcome === "compile_error" ||
          visible?.result?.report?.compileExecution?.outcome ===
            "compile_error") && (
          <p className="notice">
            Компиляция всего проекта для {visible.entryPoint}. Ошибка может
            находиться в другом файле.
          </p>
        )}
      </>
    );
  }
  const panels = {
    navigation: (
      <nav
        className="workspace-navigation-content"
        aria-label="Навигация проекта"
      >
        <button onClick={() => navigate("/projects")}>
          <House size={17} />
          Проекты
        </button>
        <button onClick={() => void workspace.reveal("graph")}>
          <Icon name="file" size={17} />
          Редактор
        </button>
        <button onClick={() => void workspace.reveal("history")}>
          <History size={17} />
          История
        </button>
        <TourButton label="Обучение редактору" mode="context" />
      </nav>
    ),
    history: (
      <section className="history-panel" id="project-history">
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
                  disabled={accessReadOnly || inFlight || dirty || conflict}
                  onClick={() => void restoreRevision(r.id)}
                >
                  Восстановить
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    ),
    project: (
      <aside className="sidebar">
        <div className="project-root">
          <FolderOpen size={16} />
          <span>{project?.name ?? "Проект"}</span>
        </div>
        <ProjectExplorer
          snapshot={{ files, directories }}
          active={file}
          search=""
          methods={graph?.methods ?? []}
          methodsDisabled={stale || analyzing}
          methodId={methodId}
          disabled={inFlight || conflict || (!!file && !editorReady)}
          readOnly={readOnly}
          onOpen={(p) => {
            setOverview(true);
            setMethodId(
              matchingMethod(graph?.methods ?? [], methodSelections.current[p])
                ?.id ??
                graph?.methods.find((m) => m.sourceRange.filePath === p)?.id ??
                "",
            );
            setSelected(null);
            setFile(p);
            workspace.reveal("code");
            setRange(null);
            setReferenceId(null);
          }}
          onMethod={(m) => {
            if (stale) return;
            setOverview(false);
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
              e.dataTransfer.setData(
                "application/x-blueprint-kind-" + kind,
                "1",
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            disabled={stale || readOnly || inFlight}
            onClick={() => {
              if (!selected || !operations.includes("insert_statement")) {
                setStatus("Перетащите блок на шаг схемы");
                return;
              }
              setOperation("insert_statement");
              previewInsertion(selected.id);
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
      <section
        className="graph-pane"
        aria-label="Схема метода"
        data-source-file={file}
      >
        <div className="editor-caption">
          <span title={file}>СХЕМА · {file.split("/").pop()}</span>
          <span>
            {overview
              ? "Обзор проекта"
              : method
                ? method.signature
                : "Выберите метод"}
          </span>
          <button onClick={() => setOverview((v) => !v)}>
            {overview ? "Выбранный метод" : "Все методы"}
          </button>
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
              ? "В редакторе есть несохранённые изменения. Схема относится к сохранённой версии."
              : "Схема относится к предыдущей сохранённой версии; обновление ещё не завершено."}
          </p>
        )}
        {graph && (overview || methodId) ? (
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
            overview={overview}
            focusNodeId={focusNode?.id}
            focusRequest={focusNode?.request}
            preview={
              !stale &&
              selected &&
              insertionPreview?.nodeId === selected.id &&
              operation === "insert_statement" &&
              ["statement", "condition", "loop"].includes(template)
                ? {
                    kind: template as "statement" | "condition" | "loop",
                    anchorNodeId: selected.id,
                    position: position as
                      "before" | "after" | "body_start" | "body_end",
                    source: statement,
                    request: insertionPreview.request,
                  }
                : null
            }
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
            title="Сохранить изменения в проекте"
            aria-label="Сохранить изменения в проекте"
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
                  disabled={
                    readOnly ||
                    inFlight ||
                    Object.hasOwn(files, target) ||
                    directoryPaths(files, directories).includes(target)
                  }
                  onClick={() =>
                    void changePath("move", file, target).catch((e) =>
                      setError(message(e)),
                    )
                  }
                >
                  Переименовать в {type}.java
                </button>
                {Object.hasOwn(files, target) && (
                  <span>
                    {target} уже существует. Выберите другое имя класса или
                    файла.
                  </span>
                )}
              </div>
            ) : null;
          })()}
        {selectionNotice && (
          <p className="small quiet" role="status">
            {selectionNotice}
          </p>
        )}
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
            onSelectionChange={(selection) => {
              if (busy || saving || treeSaving || loadingRevision || inFlight)
                return;
              if (!selection) {
                setSelectionNotice("");
                return;
              }
              if (stale || readOnly) {
                setSelectionNotice(
                  "Сначала сохраните исходник и дождитесь актуального анализа.",
                );
                return;
              }
              const bound = extractionFromSelection(
                graph,
                file,
                files[file] ?? "",
                selection.startOffset,
                selection.endOffset,
              );
              if (!bound) {
                setSelectionNotice(
                  "Выделите целые соседние операторы одного блока для извлечения метода.",
                );
                return;
              }
              setMethodId(bound.start.methodId);
              setSelected(bound.start);
              setExtractionEdit({
                nodeId: bound.start.id,
                endNodeId: bound.end.id,
                serial: ++extractionSequence.current,
              });
              setSelectionNotice("");
              setInspector(true);
            }}
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
          sourceText={files[file]}
          file={file}
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
                  <Select
                    id="node-operation"
                    value={operation}
                    disabled={inFlight || stale || readOnly}
                    onChange={(e) => {
                      setOperation(e.target.value);
                      if (e.target.value === "insert_statement")
                        previewInsertion(selected.id);
                      else setInsertionPreview(null);
                      if (
                        [
                          "optimize_membership",
                          "extract_method",
                          "decompose_class",
                          "rename_local",
                        ].includes(e.target.value)
                      )
                        setIntent("preserve_behavior");
                    }}
                  >
                    {operations.map((op) => (
                      <option key={op} value={op}>
                        {operationLabels[op]}
                      </option>
                    ))}
                  </Select>
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
                      <Select
                        id="insert-position"
                        value={position}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => {
                          previewInsertion(selected.id);
                          setPosition(e.target.value);
                        }}
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
                      </Select>
                      <label htmlFor="statement-template">Шаблон</label>
                      <Select
                        id="statement-template"
                        value={template}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => {
                          previewInsertion(selected.id);
                          setTemplate(e.target.value);
                          setStatement(statementTemplates[e.target.value]);
                        }}
                      >
                        <option value="statement">Оператор</option>
                        <option value="condition">Условие</option>
                        <option value="loop">Цикл</option>
                      </Select>
                      <label htmlFor="statement-source">Java оператор</label>
                      <textarea
                        id="statement-source"
                        value={statement}
                        rows={6}
                        spellCheck={false}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => {
                          previewInsertion(selected.id);
                          setStatement(e.target.value);
                        }}
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
                      <Select
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
                      </Select>
                      <label htmlFor="move-position">Позиция перемещения</label>
                      <Select
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
                      </Select>
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
                  {operation === "rename_local" && (
                    <>
                      <label htmlFor="renamed-local-name">
                        Новое имя переменной
                      </label>
                      <input
                        id="renamed-local-name"
                        value={renamedLocalName}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setRenamedLocalName(e.target.value)}
                      />
                      <p className="small quiet">
                        Изменяются только ссылки на выбранное объявление. На
                        входе метода с одним параметром переименовывается этот
                        параметр. Коллизии и неоднозначные ссылки отклоняются;
                        применение требует тестов.
                      </p>
                    </>
                  )}
                  {operation === "decompose_class" && (
                    <>
                      <label htmlFor="extracted-class-name">
                        Имя нового класса
                      </label>
                      <input
                        id="extracted-class-name"
                        value={extractedClassName}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setExtractedClassName(e.target.value)}
                      />
                      {!validClassName(extractedClassName) && (
                        <p className="small quiet" role="status">
                          Имя класса: до 80 латинских букв, цифр, $ или _,
                          начиная с буквы, $ или _.
                        </p>
                      )}
                      <p className="small quiet">
                        Тело статического метода переносится в отдельный класс.
                        Исходный метод сохраняет вызовы через обёртку.
                        Применение требует компиляции и совпадения тестов.
                      </p>
                    </>
                  )}
                  {operation === "extract_method" && (
                    <>
                      <p className="small quiet">
                        Начало: строка {selected.sourceRange?.startLine}.
                        Параметры и результат определяются по исходнику.
                      </p>
                      <label htmlFor="extracted-method-name">
                        Имя нового метода
                      </label>
                      <input
                        id="extracted-method-name"
                        value={extractedMethodName}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setExtractedMethodName(e.target.value)}
                      />
                      <label htmlFor="extraction-end">Последний оператор</label>
                      <Select
                        id="extraction-end"
                        value={extractionEndNodeId}
                        disabled={inFlight || stale || readOnly}
                        onChange={(e) => setExtractionEndNodeId(e.target.value)}
                      >
                        {extractionEnds.map((n) => (
                          <option key={n.id} value={n.id}>
                            Строка {n.sourceRange?.startLine}:{" "}
                            {n.label.slice(0, 90)}
                          </option>
                        ))}
                      </Select>
                      {!validMethodName(extractedMethodName) && (
                        <p className="small quiet" role="status">
                          Укажите допустимое имя Java-метода.
                        </p>
                      )}
                      <p className="small quiet">
                        Применение доступно после компиляции и совпадения
                        результатов обязательных тестов.
                      </p>
                    </>
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
                  <Select
                    id="change-intent"
                    value={
                      [
                        "optimize_membership",
                        "extract_method",
                        "decompose_class",
                        "rename_local",
                      ].includes(operation)
                        ? "preserve_behavior"
                        : intent
                    }
                    disabled={
                      inFlight ||
                      stale ||
                      readOnly ||
                      [
                        "optimize_membership",
                        "extract_method",
                        "decompose_class",
                        "rename_local",
                      ].includes(operation)
                    }
                    onChange={(e) => setIntent(e.target.value)}
                  >
                    <option value="semantic_edit">Изменить логику</option>
                    <option value="preserve_behavior">
                      Сохранить поведение
                    </option>
                  </Select>
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
      <div
        className="dock-content"
        data-source-file={file}
        data-assistant-target="run-result"
        data-assistant-run-result
        data-assistant-job-id={runJob?.id}
        data-assistant-job-status={runJob?.status}
      >
        {resultContext("run", runJob)}
        {rerunButton(runJob)}
        <>
          {runJob?.type === "run" &&
            (dirty ||
              ((runJob.revisionId ?? runReport?.revisionId) &&
                (runJob.revisionId ?? runReport?.revisionId) !==
                  revision?.id)) && (
              <div
                className="notice"
                role="status"
                data-testid="run-source-provenance"
              >
                {(runJob.revisionId ?? runReport?.revisionId)
                  ? `Вывод запуска версии ${short(runJob.revisionId ?? runReport?.revisionId)}.`
                  : "Вывод запуска сохранённой версии."}
                {dirty
                  ? " Локальный черновик ещё не запускался."
                  : " Это запуск предыдущей версии. Текущая версия кода отличается; запустите её для нового вывода."}
              </div>
            )}
          {runJob?.type === "run" &&
          ["queued", "running"].includes(runJob.status) ? (
            <LiveConsole
              projectId={projectId}
              jobId={runJob.id}
              live={runJob.live}
              status={runJob.status}
              readOnly={accessReadOnly}
            />
          ) : runReport ? (
            <ReportView
              report={runReport}
              projectId={projectId}
              cancelled={runJob?.status === "cancelled"}
            />
          ) : runJob?.status === "cancelled" ? (
            <div className="output-empty">Запуск отменён</div>
          ) : runJob?.error ? (
            <div className="notice error">
              {runJob.error.code} · {runJob.error.message}
              <button onClick={fileRuns.retry}>
                Повторить загрузку результата
              </button>
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
      <div
        className="dock-content"
        data-source-file={file}
        data-assistant-target="tests-result"
        data-assistant-test-result
        data-assistant-job-id={testJob?.id}
        data-assistant-job-status={testJob?.status}
      >
        {resultContext("compare", testJob)}
        {rerunButton(testJob)}
        {testJob?.type === "compare" &&
        (!testReport?.testResults ||
          ["queued", "running"].includes(testJob.status)) ? (
          <TestProgressView job={testJob} />
        ) : testReport?.testResults ? (
          <>
            {proposal?.status === "ready" && exactMatched && (
              <div className="verified-change">
                <button className="subtle" onClick={() => setDock("changes")}>
                  К изменению <Icon name="external" size={13} />
                </button>
              </div>
            )}
            {testReport.candidateRevisionId &&
              (dirty || testReport.candidateRevisionId !== revision?.id) && (
                <div
                  className="notice"
                  role="status"
                  data-testid="test-source-provenance"
                >
                  Результат относится к предыдущей версии{" "}
                  {short(testReport.candidateRevisionId)}. Текущий код
                  отличается; запустите тесты заново.
                </div>
              )}
            <ReportView
              report={testReport}
              projectId={projectId}
              onOpenSource={(id, path) => void openRunSource(id, path)}
              onRetry={
                !accessReadOnly && !dirty
                  ? () => setDialog("compare")
                  : undefined
              }
            />
          </>
        ) : testJob?.error ? (
          <div className="notice error">
            {testJob.error.code} · {testJob.error.message}
            <button onClick={fileRuns.retry}>
              Повторить загрузку результата
            </button>
          </div>
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
            {proposal.decomposition && (
              <div className="diff" aria-label="Новый класс">
                <code>{proposal.decomposition.filePath}</code>
                <p className="small quiet">
                  {proposal.decomposition.className}: тело{" "}
                  {proposal.decomposition.originalMethodName} перенесено;
                  исходный метод сохранён как обёртка.
                </p>
              </div>
            )}
            {proposal.extraction && (
              <div className="diff" aria-label="Извлечённый метод">
                <code>
                  private {proposal.extraction.isStatic ? "static " : ""}
                  {proposal.extraction.returnType}{" "}
                  {proposal.extraction.methodName}(
                  {proposal.extraction.parameters
                    .map((p) => p.type + " " + p.name)
                    .join(", ")}
                  )
                </code>
                <p className="small quiet">
                  Входы:{" "}
                  {proposal.extraction.parameters
                    .map((p) => p.name)
                    .join(", ") || "нет"}{" "}
                  · Выход:{" "}
                  {proposal.extraction.returnedVariable ??
                    (proposal.extraction.returnType === "void"
                      ? "нет"
                      : proposal.extraction.returnType)}
                </p>
              </div>
            )}
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
        {!workspace.navigationDocked && (
          <button
            type="button"
            className="return-navigation"
            data-return-navigation
            onClick={workspace.toggleNavigationDock}
          >
            <PanelsTopLeft size={16} />
            Закрепить панель
          </button>
        )}
        {workspace.navigationDocked &&
          !workspace.layout.hidden?.includes("navigation") && (
            <div
              className={
                "topbar-navigation" +
                (workspace.collapsedNavigation ? " collapsed" : " expanded")
              }
            >
              <button
                className="topbar-navigation-toggle"
                aria-expanded={!workspace.collapsedNavigation}
                aria-label="JavaBlueprints — навигация"
                onClick={workspace.toggleNavigation}
              >
                <span className="navigation-wordmark">
                  <img src="/brand-lockup.png" alt="" />
                  JavaBlueprints
                </span>
                <ChevronDown size={14} />
              </button>
              {!workspace.collapsedNavigation && (
                <div className="topbar-navigation-body">
                  {panels.navigation}
                  <button
                    className="navigation-undock"
                    onClick={workspace.toggleNavigationDock}
                  >
                    <PanelsTopLeft size={15} />
                    На полотно
                  </button>
                </div>
              )}
            </div>
          )}
        <ProjectSearch
          files={files}
          graph={stale ? null : graph}
          inputRef={searchInput}
          onSelect={chooseSearch}
        />
        <details
          open={wideMenu || menuExpanded}
          onToggle={(e) => {
            if (e.target === e.currentTarget && !wideMenu)
              setMenuExpanded(e.currentTarget.open);
          }}
          className="sidebar-command-menu global-command-menu"
        >
          <summary>
            Меню проекта
            <ChevronDown size={14} />
          </summary>
          <WorkspaceMenu
            workspace={workspace}
            archiveItems={
              <ProjectArchives
                key={projectId}
                projectId={projectId}
                workspace={{
                  layout: workspace.layout,
                  focused: workspace.focused,
                  maximized: workspace.maximized,
                }}
                disabled={busy}
                onError={setError}
                onRestored={(id) => navigate("/projects/" + id)}
              />
            }
            actions={{
              createFile: () => {
                workspace.reveal("project");
                setCreateCommand({ kind: "file", id: Date.now() });
              },
              createFolder: () => {
                workspace.reveal("project");
                setCreateCommand({ kind: "folder", id: Date.now() });
              },
              save: downloadDraft,
              import: () => setImportChooser(true),
              export: () => void exportRevision(),
              projects: () => navigate("/projects"),
              run: () => setDialog("run"),
              compare: () => setDialog("compare"),
              stop: stopJob,
              edit: (command) => {
                void workspace.reveal("code").then(() => {
                  if (mounted.current) editorCommands.current?.[command]();
                });
              },
              editDisabled: !file || readOnly || busy || loadingRevision,
              saveDisabled: !file || !(file in files),
              runDisabled:
                accessReadOnly ||
                !revision ||
                dirty ||
                busy ||
                !Object.keys(files).some((p) => p.endsWith(".java")),
              exportDisabled:
                !revision || busy || !canExportProjects(accountSession),
              importDisabled: busy || readOnly,
              stopDisabled: !job || !["queued", "running"].includes(job.status),
            }}
          />
        </details>
        <span className="toolbar-spacer" />
        <button
          className="local-presence"
          title="Аккаунт"
          aria-label="Открыть настройки аккаунта"
          onClick={() => navigate("/settings/profile")}
        >
          {accountSession?.user ? (
            <Avatar user={accountSession.user} />
          ) : (
            <CircleUserRound size={23} />
          )}
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
      {spotlight && (
        <TargetSpotlight
          target={spotlight}
          onClose={() => setSpotlight(null)}
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
          panels={{
            ...panels,
            navigation: workspace.navigationDocked ? null : panels.navigation,
          }}
          canvasTitle={
            <>
              <div className="canvas-breadcrumb">
                {project?.name ?? "Проект"}
                <span>›</span>
                {file}
              </div>
              <h1>{file.split("/").pop() || "JavaBlueprints"}</h1>
              <p>
                {method?.signature ?? "Выберите метод"}
                {graph && (
                  <small className="canvas-version" title={graph.revisionId}>
                    {" "}
                    · {short(graph.revisionId)}
                    {stale ? " · предыдущая схема" : " · актуальная схема"}
                  </small>
                )}
              </p>
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
            data-assistant-target="tests-start"
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
              data-assistant-target="run-start"
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
      {(importChooser || importPreview || githubImport) && (
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
                  setGithubImport(false);
                }}
              >
                ×
              </button>
            </div>
            {githubImport && !importPreview ? (
              <GitHubImport
                onClose={() => setGithubImport(false)}
                onPreview={(preview) => {
                  setImportPreview(preview);
                  setImportSelected([
                    ...preview.files.map((f) => f.path),
                    ...preview.directories,
                  ]);
                  setGithubImport(false);
                  setImportChooser(false);
                }}
              />
            ) : importPreview ? (
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
                <button onClick={() => setGithubImport(true)}>GitHub</button>
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
          activePath={file}
          onOpenSource={(id, path) => void openRunSource(id, path)}
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
  activePath,
  onOpenSource,
  onClose,
  onStart,
  onError,
}: {
  kind: "run" | "compare";
  project: Project;
  revision: Revision;
  proposal: Proposal | null;
  historyRows: Revision[];
  activePath: string;
  onOpenSource: (revisionId: string, path: string) => void;
  onClose: () => void;
  onStart: (j: Job) => void;
  onError: (e: string) => void;
}) {
  const initialEntry =
    javaEntryHint(
      revision.files.find((source) => source.path === activePath),
    ) ??
    revision.files.map(javaEntryHint).find(Boolean) ??
    "";
  const [entry, setEntry] = useState(initialEntry);
  const [argv, setArgv] = useState("[]");
  const [stdin, setStdin] = useState("");
  const [cases, setCases] = useState(
    '[\n  {"id":"case-1","name":"Вход 1","stdinUtf8":"7\\n","argv":[]},\n  {"id":"case-2","name":"Вход 2","stdinUtf8":"21\\n","argv":[]},\n  {"id":"case-3","name":"Вход 3","stdinUtf8":"99\\n","argv":[]}\n]',
  );
  const [caseFormError, setCaseFormError] = useState<string | null>(null);
  const [baseRevision, setBaseRevision] = useState(
    proposal?.baseRevisionId ??
      (() => {
        const original = historyRows.find(
          (row) => row.id === project.originalRevisionId,
        );
        return initialEntry &&
          (!original ||
            !original.files.some(
              (source) => javaEntryHint(source) === initialEntry,
            ))
          ? revision.id
          : (project.originalRevisionId ?? revision.id);
      })(),
  );
  const [candidate, setCandidate] = useState(
    proposal?.candidateRevisionId ?? revision.id,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sources = useRunSources(
    project.id,
    kind === "run"
      ? [{ id: revision.id, label: "Версия" }]
      : [
          { id: baseRevision, label: "База" },
          { id: candidate, label: "Кандидат" },
        ],
  );
  const filenameProblems = sources.sources.flatMap(({ revision }) =>
    javaFilenameIssues(revision.files, revision.directories),
  );
  const revisionChoices = [
    ...new Map(
      [
        ...(project.originalRevisionId
          ? [{ id: project.originalRevisionId }]
          : []),
        ...historyRows,
        revision,
        ...sources.sources.map((source) => source.revision),
      ].map((row) => [row.id, row]),
    ).values(),
  ];
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
    if (!sources.ready || filenameProblems.length) return;
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
                  <Select
                    value={baseRevision}
                    onChange={(e) => setBaseRevision(e.target.value)}
                  >
                    {revisionChoices.map((r) => (
                      <option key={r.id} value={r.id}>
                        {short(r.id)}
                        {r.id === project.originalRevisionId
                          ? " · исходная"
                          : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <span>→</span>
                <label>
                  Кандидат
                  <Select
                    value={candidate}
                    onChange={(e) => setCandidate(e.target.value)}
                  >
                    {revisionChoices.map((r) => (
                      <option key={r.id} value={r.id}>
                        {short(r.id)}
                        {r.id === project.headRevisionId ? " · текущая" : ""}
                      </option>
                    ))}
                  </Select>
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
        {!sources.ready && !sources.error && (
          <p className="small quiet" role="status">
            Проверяем файлы выбранных версий…
          </p>
        )}
        <SourceFilenameIssues sources={sources.sources} onOpen={onOpenSource} />
        {sources.error && (
          <div className="notice error" role="alert">
            {sources.error}{" "}
            <button onClick={sources.retry}>Повторить проверку файлов</button>
          </div>
        )}
        {kind === "compare" && baseRevision === candidate && (
          <p className="small quiet">
            Проверяется одна версия. Укажите ожидаемый вывод в тестах для
            проверки результата.
          </p>
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
            data-assistant-start
            onClick={() => void submit()}
            disabled={
              busy ||
              !sources.ready ||
              filenameProblems.length > 0 ||
              (kind === "compare" && !!caseFormError)
            }
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
  onOpenSource,
  onRetry,
}: {
  report: Report;
  projectId: string;
  cancelled?: boolean;
  onOpenSource?: (revisionId: string, path: string) => void;
  onRetry?: () => void;
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
      <>
        <ReportDownloads report={report} />
        <SingleRunOutput
          report={report}
          sourceHash={sourceHash}
          cancelled={cancelled}
        />
      </>
    );
  return (
    <div className="report">
      <ReportDownloads report={report} />
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
      {report.outcome === "compile_error" && (
        <CompileErrorHelp
          projectId={projectId}
          sources={[
            ...(report.baseRevisionId
              ? [{ id: report.baseRevisionId, label: "База" }]
              : []),
            ...(report.candidateRevisionId
              ? [{ id: report.candidateRevisionId, label: "Кандидат" }]
              : []),
          ]}
          onOpen={onOpenSource}
          onRetry={onRetry}
        />
      )}
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
          {e.metrics && (
            <>
              {" "}
              · <ExecutionResources execution={e} />
            </>
          )}
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
