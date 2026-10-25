import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useAccount, canCreateProjects, canExportProjects } from "./Account";
import type { Project } from "./types";
import { layoutKey, panelIds, migrateLayout } from "./workspaceLayout";
import type { WorkspaceLayout, PanelId } from "./workspaceLayout";

const format = "java-blueprints-project-archive-v1";
export default function ProjectArchives({
  projectId,
  workspace,
  disabled,
  onRestored,
  onError,
}: {
  projectId: string;
  workspace: {
    layout: WorkspaceLayout;
    focused: PanelId;
    maximized: PanelId | null;
  };
  disabled: boolean;
  onRestored: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { session } = useAccount();
  const mayCreate = canCreateProjects(session),
    mayExport = canExportProjects(session);
  const epoch = useRef(0),
    controller = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    mounted = useRef(true);
  const pending = useRef<{
    createKey: string;
    importKey: string;
    projectId?: string;
    createName?: string;
  }>({ createKey: crypto.randomUUID(), importKey: crypto.randomUUID() });
  const [busy, setBusy] = useState(false),
    [archive, setArchive] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState("Проект из архива"),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    dialog.current?.close();
    setArchive(null);
    setBusy(false);
    setError("");
    pending.current = {
      createKey: crypto.randomUUID(),
      importKey: crypto.randomUUID(),
    };
  }, [session?.user?.id, session?.capabilities.legacyGuestWorkspace]);
  function operation() {
    controller.current?.abort();
    const abort = new AbortController(),
      ticket = epoch.current;
    controller.current = abort;
    return {
      signal: abort.signal,
      current: () =>
        mounted.current && ticket === epoch.current && !abort.signal.aborted,
    };
  }
  useEffect(() => {
    if (archive) dialog.current?.showModal();
  }, [archive]);
  function close() {
    if (busy) return;
    dialog.current?.close();
    setArchive(null);
    setError("");
    trigger.current?.focus();
  }
  async function download() {
    if (!mayExport || disabled || busy) return;
    const { signal, current } = operation();
    setBusy(true);
    try {
      const result = await api<{ downloadUrl: string; fileName: string }>(
        `/projects/${projectId}/archives`,
        { method: "POST", body: { workspace }, signal },
      );
      if (!current()) return;
      const link = document.createElement("a");
      link.href = result.downloadUrl;
      link.download = result.fileName;
      link.click();
    } catch (e) {
      if (current())
        onError(e instanceof Error ? e.message : "Не удалось создать архив");
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function read(file?: File) {
    if (!file || !mayCreate || disabled || busy) return;
    const { current } = operation();
    setBusy(true);
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("Размер архива не должен превышать 32 МиБ");
      const value = JSON.parse(await file.text());
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.format !== format
      )
        throw new Error("Выберите архив Java Blueprints (.jbp.json)");
      if (current()) {
        pending.current = {
          createKey: crypto.randomUUID(),
          importKey: crypto.randomUUID(),
        };
        setArchive(value);
        setError("");
        setName("Проект из архива");
      }
    } catch (e) {
      if (current())
        onError(e instanceof Error ? e.message : "Не удалось прочитать архив");
    } finally {
      if (current()) {
        setBusy(false);
        if (picker.current) picker.current.value = "";
      }
    }
  }
  async function restore() {
    if (!mayCreate || !archive || !name.trim() || busy) return;
    const { signal, current } = operation();
    setBusy(true);
    setError("");
    try {
      await api("/archive-previews", {
        method: "POST",
        body: { archive },
        signal,
      });
      if (!current()) return;
      const request = pending.current;
      if (!request.projectId) {
        request.createName ??= name.trim();
        const project = await api<Project>("/projects", {
          method: "POST",
          body: { name: request.createName },
          key: request.createKey,
          signal,
        });
        request.projectId = project.id;
      }
      if (!current()) return;
      await api(`/projects/${request.projectId}/archive-imports`, {
        method: "POST",
        head: null,
        body: { archive },
        key: request.importKey,
        signal,
      });
      if (!current()) return;
      const state = (
        archive.payload as { workspace?: typeof workspace } | undefined
      )?.workspace;
      const restoredLayout = state && migrateLayout(state.layout);
      if (restoredLayout)
        try {
          localStorage.setItem(
            layoutKey(request.projectId),
            JSON.stringify(restoredLayout),
          );
          localStorage.setItem(
            "java-blueprints:window-state:" + request.projectId,
            JSON.stringify({
              focused: panelIds.includes(state.focused)
                ? state.focused
                : "graph",
              maximized:
                state.maximized && panelIds.includes(state.maximized)
                  ? state.maximized
                  : null,
            }),
          );
        } catch {
          /* Browser storage may be unavailable; imported source remains valid. */
        }
      if (current()) {
        dialog.current?.close();
        setArchive(null);
        onRestored(request.projectId);
      }
    } catch (e) {
      if (current())
        setError(
          e instanceof Error ? e.message : "Не удалось восстановить архив",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={disabled || busy || !mayExport}
        onClick={() => void download()}
      >
        Скачать архив проекта
      </button>
      <button
        type="button"
        ref={trigger}
        disabled={disabled || busy || !mayCreate}
        onClick={() => picker.current?.click()}
      >
        Открыть архив проекта…
      </button>
      <input
        hidden
        type="file"
        ref={picker}
        accept=".json,application/json"
        aria-label="Файл архива проекта"
        onChange={(e) => void read(e.target.files?.[0])}
      />
      {archive &&
        createPortal(
          <dialog
            className="modal project-archive-dialog"
            ref={dialog}
            aria-labelledby="archive-title"
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void restore();
              }}
            >
              <div className="modal-heading">
                <h2 id="archive-title">Открыть архив</h2>
                <button
                  type="button"
                  aria-label="Закрыть архив"
                  disabled={busy}
                  onClick={close}
                >
                  ×
                </button>
              </div>
              <p className="quiet">
                История откроется в новом проекте. Архивные результаты
                сохранятся; изменения нужно проверить повторным запуском тестов.
              </p>
              <label htmlFor="archive-project-name">Название проекта</label>
              <input
                id="archive-project-name"
                autoFocus
                maxLength={120}
                value={name}
                disabled={busy || !!pending.current.createName}
                onChange={(e) => setName(e.target.value)}
              />
              {error && (
                <p className="warning" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button type="button" disabled={busy} onClick={close}>
                  Отмена
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !mayCreate || !name.trim()}
                >
                  {busy ? "Открываем…" : "Открыть в новом проекте"}
                </button>
              </div>
            </form>
          </dialog>,
          document.body,
        )}
    </>
  );
}
