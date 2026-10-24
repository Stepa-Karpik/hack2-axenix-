import { useEffect, useRef, useState } from "react";
import { BookOpen, Users } from "lucide-react";
import { api } from "./api";
import { accountError, PageLink, ProductShell, useAccount } from "./Account";
import type { AccountUser } from "./Account";
import type { Project } from "./types";
import type { FriendRequest } from "./FriendsPage";
export default function ProfilePage({ username }: { username: string }) {
  const { session } = useAccount();
  const [user, setUser] = useState<AccountUser | null>(null),
    [projects, setProjects] = useState<Project[]>([]),
    [friends, setFriends] = useState<AccountUser[]>([]),
    [requests, setRequests] = useState<{
      incoming: FriendRequest[];
      outgoing: FriendRequest[];
    }>({ incoming: [], outgoing: [] }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const own = session?.user?.username === username;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setUser(null);
    const base = "/users/" + encodeURIComponent(username);
    Promise.all([api<AccountUser>(base), api<Project[]>(base + "/projects")])
      .then(([u, p]) => {
        if (active) {
          setUser(u);
          setProjects(p);
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
  }, [username]);
  async function loadRelations() {
    if (!session?.user) return;
    const [f, r] = await Promise.all([
      api<AccountUser[]>("/friends"),
      api<typeof requests>("/friend-requests"),
    ]);
    setFriends(f);
    setRequests(r);
  }
  useEffect(() => {
    if (session?.user)
      void loadRelations().catch((e) => setError(accountError(e)));
  }, [session?.user?.id, username]);
  async function relation(path: string, body: unknown = {}, method = "POST") {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body });
      await loadRelations();
    } catch (e) {
      setError(accountError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const incoming = requests.incoming.find((r) => r.from.id === user?.id),
    outgoing = requests.outgoing.find((r) => r.to.id === user?.id),
    friend = friends.some((f) => f.id === user?.id);
  return (
    <ProductShell>
      <main className="profile-main">
        {loading ? (
          <p className="product-muted">Загрузка профиля…</p>
        ) : user ? (
          <div className="profile-layout">
            <aside className="profile-summary">
              <div className="profile-avatar">
                {(user.displayName || user.username).slice(0, 1).toUpperCase()}
              </div>
              <h1>{user.displayName || user.username}</h1>
              <p className="profile-handle">@{user.username}</p>
              {user.bio && <p className="profile-bio">{user.bio}</p>}
              {own ? (
                <PageLink className="product-outline" to="/settings">
                  Редактировать профиль
                </PageLink>
              ) : session?.user ? (
                <div className="profile-friend-action">
                  {friend ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void relation(
                          "/friends/" + encodeURIComponent(user.id),
                          {},
                          "DELETE",
                        )
                      }
                    >
                      Удалить из друзей
                    </button>
                  ) : incoming ? (
                    <>
                      <button
                        className="product-action"
                        disabled={busy}
                        onClick={() =>
                          void relation(
                            "/friend-requests/" +
                              encodeURIComponent(incoming.id) +
                              "/accept",
                          )
                        }
                      >
                        Принять заявку
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void relation(
                            "/friend-requests/" +
                              encodeURIComponent(incoming.id) +
                              "/decline",
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
                        void relation(
                          "/friend-requests/" +
                            encodeURIComponent(outgoing.id) +
                            "/cancel",
                        )
                      }
                    >
                      Отменить заявку
                    </button>
                  ) : (
                    <button
                      className="product-action"
                      disabled={busy}
                      onClick={() =>
                        void relation("/friend-requests", {
                          username: user.username,
                        })
                      }
                    >
                      <Users size={16} /> Добавить в друзья
                    </button>
                  )}
                </div>
              ) : (
                <PageLink className="product-outline" to="/login">
                  Войти, чтобы добавить в друзья
                </PageLink>
              )}
            </aside>
            <section className="profile-projects">
              <div className="profile-tab">
                <BookOpen size={17} /> Публичные проекты{" "}
                <span>{projects.length}</span>
              </div>
              <div className="public-project-grid">
                {projects.map((p) => (
                  <PageLink
                    key={p.id}
                    to={"/projects/" + encodeURIComponent(p.id)}
                    className="public-project-card"
                  >
                    <BookOpen size={18} />
                    <h2>{p.name}</h2>
                    <span className="project-visibility">Публичный</span>
                    <p className="product-muted">
                      Java · {new Date(p.updatedAt).toLocaleDateString("ru-RU")}
                    </p>
                  </PageLink>
                ))}
              </div>
              {!projects.length && (
                <div className="profile-project-empty">
                  <BookOpen size={28} />
                  <h2>Публичных проектов пока нет</h2>
                  <p className="product-muted">
                    Здесь появятся проекты, которыми пользователь поделится
                    публично.
                  </p>
                </div>
              )}
            </section>
          </div>
        ) : null}
        {error && (
          <p className="product-feedback error" role="alert">
            {error}
          </p>
        )}
      </main>
    </ProductShell>
  );
}
