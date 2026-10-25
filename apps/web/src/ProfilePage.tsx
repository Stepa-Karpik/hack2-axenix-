import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import { api } from "./api";
import { accountError, PageLink, ProductShell, useAccount } from "./Account";
import type { AccountUser } from "./Account";
import type { Project } from "./types";
import type { FriendRequest } from "./FriendsPage";
type Overview = {
  user: AccountUser;
  projects: {
    items: Project[];
    nextCursor: string | null;
    totalVisible: number;
  };
  pinnedProjects: Project[];
  friends: { count: number; mutualCount: number };
  contributions: { days: { date: string; count: number }[]; total: number };
  activity: {
    revisionId: string;
    projectId: string;
    projectName: string;
    createdAt: string;
    origin: string | null;
  }[];
};
export default function ProfilePage({ username }: { username: string }) {
  const { session } = useAccount();
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [friends, setFriends] = useState<AccountUser[]>([]),
    [requests, setRequests] = useState<{
      incoming: FriendRequest[];
      outgoing: FriendRequest[];
    }>({ incoming: [], outgoing: [] });
  const epoch = useRef(0),
    lock = useRef(false);
  const base = "/users/" + encodeURIComponent(username);
  const identity = username + ":" + (session?.user?.id ?? "guest");
  const [loadedIdentity, setLoadedIdentity] = useState("");
  useEffect(() => {
    const ticket = ++epoch.current;
    setData(null);
    setError("");
    setBusy(false);
    lock.current = false;
    setFriends([]);
    setRequests({ incoming: [], outgoing: [] });
    api<Overview>(base + "/overview")
      .then((d) => {
        if (ticket === epoch.current) {
          setData(d);
          setLoadedIdentity(identity);
        }
      })
      .catch((e) => {
        if (ticket === epoch.current) setError(accountError(e));
      });
    if (session?.user)
      Promise.all([
        api<AccountUser[]>("/friends"),
        api<typeof requests>("/friend-requests"),
      ])
        .then(([f, r]) => {
          if (ticket === epoch.current) {
            setFriends(f);
            setRequests(r);
          }
        })
        .catch((e) => {
          if (ticket === epoch.current) setError(accountError(e));
        });
    return () => {
      epoch.current++;
    };
  }, [identity]);
  async function action(path: string, body: unknown = {}, method = "POST") {
    if (lock.current) return;
    const ticket = epoch.current;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body });
      if (ticket !== epoch.current) return;
      const d = await api<Overview>(base + "/overview");
      if (ticket !== epoch.current) return;
      setData(d);
      if (session?.user) {
        const [f, r] = await Promise.all([
          api<AccountUser[]>("/friends"),
          api<typeof requests>("/friend-requests"),
        ]);
        if (ticket === epoch.current) {
          setFriends(f);
          setRequests(r);
        }
      }
    } catch (e) {
      if (ticket === epoch.current) setError(accountError(e));
    } finally {
      if (ticket === epoch.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }
  async function more() {
    if (lock.current || !data?.projects.nextCursor) return;
    const ticket = epoch.current;
    lock.current = true;
    setBusy(true);
    try {
      const d = await api<Overview>(
        base +
          "/overview?before=" +
          encodeURIComponent(data.projects.nextCursor),
      );
      if (ticket === epoch.current)
        setData((old) =>
          old
            ? {
                ...old,
                projects: {
                  ...d.projects,
                  items: [...old.projects.items, ...d.projects.items],
                },
              }
            : d,
        );
    } catch (e) {
      if (ticket === epoch.current) setError(accountError(e));
    } finally {
      if (ticket === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const visible = loadedIdentity === identity ? data : null;
  const own = !!visible && visible.user.id === session?.user?.id;
  const incoming = requests.incoming.find(
      (r) => r.from.id === visible?.user.id,
    ),
    outgoing = requests.outgoing.find((r) => r.to.id === visible?.user.id),
    friend = friends.some((f) => f.id === visible?.user.id);
  function projectCard(p: Project) {
    const pinned = visible?.pinnedProjects.some((v) => v.id === p.id);
    return (
      <article className="public-project-card" key={p.id}>
        <PageLink to={"/projects/" + encodeURIComponent(p.id)}>
          <BookOpen size={18} />
          <h3>{p.name}</h3>
        </PageLink>
        <span className="project-visibility">
          {p.visibility === "public" ? "Публичный" : "Приватный"}
          {p.ownerId !== visible?.user.id ? " · Общий доступ" : ""}
        </span>
        <p className="product-muted">
          Java · {new Date(p.updatedAt).toLocaleDateString("ru-RU")}
        </p>
        {own && p.ownerId === session?.user?.id && (
          <button
            className="project-pin"
            disabled={
              busy || (!pinned && (visible?.pinnedProjects.length ?? 0) >= 6)
            }
            aria-pressed={pinned}
            onClick={() =>
              void action(
                "/profile/pins",
                {
                  projectIds: pinned
                    ? visible!.pinnedProjects
                        .filter((v) => v.id !== p.id)
                        .map((v) => v.id)
                    : [...visible!.pinnedProjects.map((v) => v.id), p.id],
                },
                "PUT",
              )
            }
          >
            {pinned ? "Открепить" : "Закрепить"}
          </button>
        )}
      </article>
    );
  }
  return (
    <ProductShell>
      <main className="profile-main">
        {visible ? (
          <div className="profile-layout">
            <aside className="profile-summary" data-tour="profile">
              <div className="profile-avatar">
                {(visible.user.displayName || username)
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
              <h1>{visible.user.displayName || username}</h1>
              <p className="profile-handle">@{username}</p>
              <p className="profile-bio">{visible.user.bio}</p>
              <div className="profile-counts">
                <PageLink
                  to={"/u/" + encodeURIComponent(username) + "/friends"}
                >
                  {visible.friends.count} друзей
                </PageLink>
                {!own && session?.user && (
                  <span>{visible.friends.mutualCount} общих</span>
                )}
              </div>
              {own ? (
                <PageLink className="product-outline" to="/settings/profile">
                  Редактировать профиль
                </PageLink>
              ) : session?.user ? (
                <div className="profile-friend-action">
                  {friend ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action("/friends/" + visible.user.id, {}, "DELETE")
                      }
                    >
                      Удалить из друзей
                    </button>
                  ) : incoming ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(
                            "/friend-requests/" + incoming.id + "/accept",
                          )
                        }
                      >
                        Принять заявку
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(
                            "/friend-requests/" + incoming.id + "/decline",
                          )
                        }
                      >
                        Отклонить
                      </button>
                    </>
                  ) : outgoing ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(
                          "/friend-requests/" + outgoing.id + "/cancel",
                        )
                      }
                    >
                      Отменить заявку
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      className="product-action"
                      onClick={() =>
                        void action("/friend-requests", { username })
                      }
                    >
                      Добавить в друзья
                    </button>
                  )}
                </div>
              ) : (
                <PageLink to="/login">Войти, чтобы добавить в друзья</PageLink>
              )}
            </aside>
            <div className="profile-projects">
              {visible.pinnedProjects.length > 0 && (
                <section>
                  <h2>Закреплённые проекты</h2>
                  <div className="public-project-grid">
                    {visible.pinnedProjects.map(projectCard)}
                  </div>
                </section>
              )}
              <section className="profile-section">
                <h2>
                  Проекты <small>{visible.projects.totalVisible}</small>
                </h2>
                <p className="product-muted">
                  {own
                    ? "Ваши проекты и проекты с предоставленным вам доступом."
                    : "Проекты пользователя, доступные вам для просмотра."}
                </p>
                <div className="public-project-grid">
                  {visible.projects.items.map(projectCard)}
                </div>
                {!visible.projects.items.length && (
                  <p className="product-muted">Доступных проектов пока нет.</p>
                )}
                {visible.projects.nextCursor && (
                  <button disabled={busy} onClick={() => void more()}>
                    Показать ещё проекты
                  </button>
                )}
              </section>
              <section className="profile-section product-card">
                <h2>
                  {visible.contributions.total} изменений за последний год
                </h2>
                <p className="product-muted">
                  Опубликованные версии доступных вам проектов · UTC
                </p>
                <div
                  className="contribution-calendar"
                  aria-label="Календарь изменений за год"
                >
                  {visible.contributions.days.map((day) => (
                    <span
                      key={day.date}
                      className="contribution-day"
                      data-level={Math.min(3, day.count)}
                      title={`${day.date}: ${day.count} изменений`}
                      aria-label={`${day.date}: ${day.count} изменений`}
                    />
                  ))}
                </div>
                <p className="product-muted">
                  Старая история без указания автора не учитывается.
                </p>
              </section>
              <section className="profile-section">
                <h2>Последние изменения</h2>
                {visible.activity.map((a, i) => (
                  <div className="activity-row" key={a.revisionId + ":" + i}>
                    <PageLink to={"/projects/" + a.projectId}>
                      {a.projectName}
                    </PageLink>
                    <time>{new Date(a.createdAt).toLocaleString("ru-RU")}</time>
                  </div>
                ))}
                {!visible.activity.length && (
                  <p className="product-muted">
                    Пока нет изменений с подтверждённым автором.
                  </p>
                )}
              </section>
            </div>
          </div>
        ) : (
          !error && <p>Загрузка профиля…</p>
        )}
        {error && (
          <p role="alert" className="product-feedback error">
            {error}
          </p>
        )}
      </main>
    </ProductShell>
  );
}
