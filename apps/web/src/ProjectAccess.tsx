import { useEffect, useRef, useState } from "react";
import { Check, Copy, Lock, X } from "lucide-react";
import { api, projectPath } from "./api";
import { accountError } from "./Account";
import type { AccountUser } from "./Account";
import type { Project } from "./types";
interface Member {
  user: AccountUser;
  role: "viewer" | "editor";
}
export default function ProjectAccess({
  project,
  onClose,
  onUpdate,
}: {
  project: Project;
  onClose: () => void;
  onUpdate: (p: Project) => void;
}) {
  const owner = project.role === "owner",
    legacy =
      project.visibility === "legacy_local" || project.role === "local_guest";
  const [members, setMembers] = useState<Member[]>([]),
    [friends, setFriends] = useState<AccountUser[]>([]),
    [username, setUsername] = useState(""),
    [role, setRole] = useState<"viewer" | "editor">("viewer"),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(owner),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  const lock = useRef(false),
    close = useRef<HTMLButtonElement>(null);
  const base = projectPath(project.id);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    Promise.all([
      api<Member[]>(base + "/members"),
      api<AccountUser[]>("/friends"),
    ])
      .then(([m, f]) => {
        if (active) {
          setMembers(m);
          setFriends(f);
        }
      })
      .catch((e) => {
        if (active) setError(accountError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, owner]);
  async function mutate(path: string, method: string, body?: unknown) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (path.endsWith("/access")) {
        const next = await api<Project>(path, { method, body });
        onUpdate(next);
      } else {
        await api(path, { method, body });
        setMembers(await api<Member[]>(base + "/members"));
        setUsername("");
      }
    } catch (e) {
      setError(accountError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop access-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="product-page project-access"
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const nodes = e.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
            );
            if (!nodes.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="access-heading">
          <div>
            <h2 id="access-title">Доступ к проекту</h2>
            <p className="product-muted">{project.name}</p>
          </div>
          <button
            ref={close}
            aria-label="Закрыть доступ к проекту"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="access-link">
          <input
            readOnly
            aria-label="Ссылка на проект"
            value={location.origin + "/projects/" + project.id}
          />
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(location.origin + "/projects/" + project.id)
                .then(() => setCopied(true))
                .catch(() => setError("Не удалось скопировать ссылку"));
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
            {copied ? "Скопировано" : "Копировать"}
          </button>
        </div>
        <p className="product-muted access-note">
          {legacy
            ? "Локальный проект доступен на этом сервере. Ссылка не открывает доступ через интернет."
            : project.visibility === "public"
              ? "Публичный проект доступен для просмотра всем пользователям сервера."
              : "Ссылка открывается только у владельца и приглашённых участников."}
        </p>
        {owner ? (
          <>
            <div className="setting-row access-visibility">
              <div>
                <strong>Видимость</strong>
                <p className="product-muted">
                  Публичный проект появляется в вашем профиле.
                </p>
              </div>
              <select
                aria-label="Видимость проекта"
                disabled={busy}
                value={project.visibility ?? "private"}
                onChange={(e) =>
                  void mutate(base + "/access", "PATCH", {
                    visibility: e.target.value,
                  })
                }
              >
                <option value="private">Приватный</option>
                <option value="public">Публичный</option>
              </select>
            </div>
            <h3>Участники</h3>
            {loading ? (
              <p className="product-muted">Загрузка…</p>
            ) : (
              <>
                <form
                  className="access-invite"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void mutate(base + "/members", "POST", { username, role });
                  }}
                >
                  <label>
                    Друг
                    <select
                      required
                      aria-label="Друг для приглашения"
                      disabled={busy}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    >
                      <option value="">Выберите друга</option>
                      {friends
                        .filter((f) => !members.some((m) => m.user.id === f.id))
                        .map((f) => (
                          <option key={f.id} value={f.username}>
                            @{f.username}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Роль
                    <select
                      aria-label="Роль участника"
                      disabled={busy}
                      value={role}
                      onChange={(e) => setRole(e.target.value as typeof role)}
                    >
                      <option value="viewer">Просмотр</option>
                      <option value="editor">Редактирование</option>
                    </select>
                  </label>
                  <button disabled={busy || !username}>Пригласить</button>
                </form>
                {!friends.length && (
                  <p className="product-muted">
                    Чтобы пригласить участника, сначала добавьте его в друзья.
                  </p>
                )}
                {members.map((m) => (
                  <div className="person-row" key={m.user.id}>
                    <div className="person-details">
                      <strong>{m.user.displayName || m.user.username}</strong>
                      <small>
                        @{m.user.username} ·{" "}
                        {m.role === "editor" ? "Редактирование" : "Просмотр"}
                      </small>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          base + "/members/" + encodeURIComponent(m.user.id),
                          "DELETE",
                        )
                      }
                    >
                      Убрать доступ
                    </button>
                  </div>
                ))}
              </>
            )}
          </>
        ) : !legacy ? (
          <p className="access-role">
            <Lock size={15} />
            {project.canEdit
              ? "Вам доступно редактирование. Доступом управляет владелец."
              : "Вам доступен просмотр. Доступом управляет владелец."}
          </p>
        ) : null}
        {error && (
          <p role="alert" className="product-feedback error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
