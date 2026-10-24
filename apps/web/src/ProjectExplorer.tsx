import { useEffect, useRef, useState } from "react";
import {
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FilePlus2,
  FolderPlus,
  Pencil,
  Move,
  ChevronDown,
  ChevronRight,
  Download,
  Trash2,
} from "lucide-react";
import { directoryPaths, languageFor } from "./projectFiles";
import type { FileSnapshot } from "./projectFiles";
import type { Method } from "./types";
export function FileGlyph({ path }: { path: string }) {
  const language = languageFor(path);
  if (language === "java" || language === "python")
    return (
      <span
        className={"file-type-icon language-" + language}
        aria-hidden="true"
      >
        {language === "java" ? "J" : "Py"}
      </span>
    );
  return languageFor(path) === "plaintext" ? (
    <FileText size={15} aria-hidden="true" />
  ) : (
    <FileCode2
      size={15}
      aria-hidden="true"
      className={"file-language language-" + languageFor(path)}
    />
  );
}
export default function ProjectExplorer({
  snapshot,
  active,
  search,
  methods,
  methodId,
  methodsDisabled = false,
  disabled,
  readOnly = false,
  onOpen,
  onMethod,
  onChange,
  onImport,
  onDownload,
  createCommand,
}: {
  snapshot: FileSnapshot;
  active: string;
  search: string;
  methods: Method[];
  methodId: string;
  methodsDisabled?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  onOpen: (p: string) => void;
  onMethod: (m: Method) => void;
  onChange: (
    kind: "file" | "folder" | "move" | "delete",
    path: string,
    target: string,
  ) => Promise<void>;
  onImport: () => void;
  onDownload: (path: string) => void;
  createCommand?: { kind: "file" | "folder"; id: number };
}) {
  const editingDisabled = disabled || readOnly;
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    setSelected(active);
  }, [active]);
  const [action, setAction] = useState<"file" | "folder" | "move" | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState("");
  const [deletePath, setDeletePath] = useState("");
  const [deleting, setDeleting] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const cancelled = useRef(false);
  const dirs = directoryPaths(snapshot.files, snapshot.directories);
  const all = [...Object.keys(snapshot.files), ...dirs].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  function begin(kind: "file" | "folder" | "move") {
    if (editingDisabled) return;
    cancelled.current = false;
    setAction(kind);
    setError("");
    setTarget(
      kind === "move"
        ? selected
        : dirs.includes(selected)
          ? selected + "/"
          : selected.includes("/")
            ? selected.slice(0, selected.lastIndexOf("/") + 1)
            : "",
    );
  }
  useEffect(() => {
    if (createCommand) begin(createCommand.kind);
  }, [createCommand]);
  useEffect(() => {
    if (!action) return;
    const frame = requestAnimationFrame(() => nameInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [action]);
  async function submit() {
    if (editingDisabled || !action || submitting.current || cancelled.current)
      return;
    if (!target.trim() || (action !== "move" && target.trim().endsWith("/"))) {
      setAction(null);
      return;
    }
    submitting.current = true;
    try {
      await onChange(action, selected, target.trim());
      setAction(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить путь");
    } finally {
      submitting.current = false;
    }
  }
  function render(parent: string, depth: number) {
    return all
      .filter(
        (p) =>
          p.slice(0, p.lastIndexOf("/") < 0 ? 0 : p.lastIndexOf("/")) ===
          parent,
      )
      .map((path) => {
        const folder = dirs.includes(path);
        const ownMethods = methods.filter(
          (m) =>
            m.sourceRange.filePath === path &&
            m.signature.toLowerCase().includes(search.toLowerCase()),
        );
        if (
          search &&
          !path.toLowerCase().includes(search.toLowerCase()) &&
          !ownMethods.length &&
          !(
            folder &&
            all.some(
              (p) =>
                p.startsWith(path + "/") &&
                (p.toLowerCase().includes(search.toLowerCase()) ||
                  methods.some(
                    (m) =>
                      m.sourceRange.filePath === p &&
                      m.signature.toLowerCase().includes(search.toLowerCase()),
                  )),
            )
          )
        )
          return null;
        const closed = collapsed.includes(path) && !search;
        return (
          <div key={path}>
            <button
              type="button"
              data-file-path={path}
              data-directory-path={folder ? path : undefined}
              className={
                "file-item explorer-item " +
                (selected === path || active === path ? "active" : "")
              }
              style={{ paddingLeft: 10 + depth * 14 }}
              draggable={!editingDisabled}
              onDragStart={(e) => {
                setDrag(path);
                e.dataTransfer.setData("text/x-project-path", path);
                e.stopPropagation();
              }}
              onDragEnd={() => setDrag("")}
              onDragOver={(e) => {
                if (folder && drag) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDrop={(e) => {
                if (editingDisabled || !folder || !drag) return;
                e.preventDefault();
                e.stopPropagation();
                void onChange(
                  "move",
                  drag,
                  path + "/" + drag.split("/").pop(),
                ).catch((e) => setError(e.message));
                setDrag("");
              }}
              onClick={() => {
                setSelected(path);
                if (folder)
                  setCollapsed((c) =>
                    closed ? c.filter((p) => p !== path) : [...c, path],
                  );
                else onOpen(path);
              }}
              onKeyDown={(e) => {
                if (e.key === "F2" && !editingDisabled) {
                  e.preventDefault();
                  setSelected(path);
                  setTarget(path);
                  setAction("move");
                }
              }}
              title={path}
            >
              {folder ? (
                <>
                  {closed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}{" "}
                  {closed ? <Folder size={15} /> : <FolderOpen size={15} />}
                </>
              ) : (
                <FileGlyph path={path} />
              )}
              <span>{path.split("/").pop()}</span>
            </button>
            {folder && !closed ? render(path, depth + 1) : null}
            {!folder &&
              ownMethods.map((m) => (
                <button
                  key={m.id}
                  className={
                    "method-item " + (methodId === m.id ? "active" : "")
                  }
                  style={{ paddingLeft: 26 + depth * 14 }}
                  disabled={disabled || methodsDisabled}
                  onClick={() => onMethod(m)}
                >
                  {m.signature}
                </button>
              ))}
          </div>
        );
      });
  }
  return (
    <>
      <div className="explorer-tools">
        <button
          aria-label="Создать файл"
          title="Создать файл"
          disabled={editingDisabled}
          onClick={() => begin("file")}
        >
          <FilePlus2 size={16} />
        </button>
        <button
          aria-label="Создать папку"
          title="Создать папку"
          disabled={editingDisabled}
          onClick={() => begin("folder")}
        >
          <FolderPlus size={16} />
        </button>
        <button
          aria-label="Переименовать"
          title="Переименовать · F2"
          disabled={editingDisabled || !selected}
          onClick={() => begin("move")}
        >
          <Pencil size={15} />
        </button>
        <button
          aria-label="Переместить"
          title="Переместить"
          disabled={editingDisabled || !selected}
          onClick={() => begin("move")}
        >
          <Move size={15} />
        </button>
        <button
          aria-label="Удалить выбранный путь"
          title="Удалить файл или папку"
          disabled={editingDisabled || !selected}
          onClick={() => {
            setDeletePath(selected);
            setError("");
          }}
        >
          <Trash2 size={15} />
        </button>
        <button
          aria-label="Скачать выбранный путь"
          title="Скачать выбранный путь сохранённой версии"
          disabled={disabled || !selected}
          onClick={() => onDownload(selected)}
        >
          <Download size={15} />
        </button>
        <button disabled={editingDisabled} onClick={onImport}>
          Импорт
        </button>
      </div>
      {deletePath && (
        <section
          className="explorer-form"
          role="alertdialog"
          aria-labelledby="delete-path-title"
          aria-describedby="delete-path-description"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !deleting) {
              e.stopPropagation();
              setDeletePath("");
            }
          }}
        >
          <strong id="delete-path-title">Удалить {deletePath}?</strong>
          <p id="delete-path-description" className="small">
            {dirs.includes(deletePath)
              ? "Папка и всё её содержимое будут удалены."
              : "Файл будет удалён."}{" "}
            Несохранённые изменения остальных файлов войдут в новую версию.
            Удалённое содержимое останется в истории сохранённых версий;
            несохранённые правки удаляемых файлов будут потеряны.
          </p>
          <button
            autoFocus
            disabled={deleting}
            onClick={() => setDeletePath("")}
          >
            Отмена
          </button>
          <button
            disabled={editingDisabled || deleting}
            onClick={async () => {
              if (editingDisabled || submitting.current) return;
              submitting.current = true;
              setDeleting(true);
              try {
                await onChange("delete", deletePath, "");
                setSelected("");
                setDeletePath("");
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Не удалось удалить путь",
                );
              } finally {
                submitting.current = false;
                setDeleting(false);
              }
            }}
          >
            Удалить из текущей версии
          </button>
        </section>
      )}
      {action && (
        <form
          className="explorer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="explorer-path">
            {action === "file"
              ? "Путь нового файла"
              : action === "folder"
                ? "Путь новой папки"
                : "Новый путь"}
          </label>
          <input
            id="explorer-path"
            ref={nameInput}
            autoFocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={(e) => {
              if (
                action !== "move" &&
                e.currentTarget.isConnected &&
                target.trim() &&
                !target.trim().endsWith("/")
              )
                void submit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                cancelled.current = true;
                setAction(null);
              }
            }}
          />
          {action !== "move" && (
            <span className="inline-file-icon">
              {action === "folder" ? (
                <Folder size={15} />
              ) : (
                <FileGlyph path={target || "untitled.txt"} />
              )}
            </span>
          )}
          {action === "move" && (
            <div>
              <button type="submit" disabled={editingDisabled}>
                Применить
              </button>
              <button type="button" onClick={() => setAction(null)}>
                Отмена
              </button>
            </div>
          )}
          {action === "move" && (
            <p className="small quiet">
              Меняется путь. Java package, imports и имя класса остаются в
              исходнике.
            </p>
          )}
        </form>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      <div
        className="file-tree"
        onDragOver={(e) => {
          if (drag) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          void onChange("move", drag, drag.split("/").pop()!).catch((e) =>
            setError(e.message),
          );
          setDrag("");
        }}
      >
        {render("", 0)}
      </div>
    </>
  );
}
