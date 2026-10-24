import { useEffect, useRef, useState } from "react";
import { Search, Users } from "lucide-react";
import { api } from "./api";
import {
  accountError,
  PageLink,
  ProductShell,
  SignedInRequired,
  useAccount,
} from "./Account";
import type { AccountUser } from "./Account";
export interface FriendRequest {
  id: string;
  from: AccountUser;
  to: AccountUser;
  createdAt: string;
}
export default function FriendsPage() {
  const { session, loading } = useAccount();
  const [friends, setFriends] = useState<AccountUser[]>([]),
    [requests, setRequests] = useState<{
      incoming: FriendRequest[];
      outgoing: FriendRequest[];
    }>({ incoming: [], outgoing: [] }),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<AccountUser[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [fetching, setFetching] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  async function load() {
    setFetching(true);
    try {
      const [f, r] = await Promise.all([
        api<AccountUser[]>("/friends"),
        api<typeof requests>("/friend-requests"),
      ]);
      setFriends(f);
      setRequests(r);
      setError("");
    } catch (e) {
      setError(accountError(e));
    } finally {
      setFetching(false);
    }
  }
  useEffect(() => {
    if (session?.user) void load();
  }, [session?.user?.id]);
  async function mutate(path: string, method = "POST", body: unknown = {}) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body });
      await load();
    } catch (e) {
      setError(accountError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function search() {
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const users = await api<AccountUser[]>(
        "/users?q=" + encodeURIComponent(query.trim()),
      );
      if (current === epoch.current) setResults(users);
    } catch (e) {
      if (current === epoch.current) setError(accountError(e));
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  function row(user: AccountUser, action?: React.ReactNode) {
    return (
      <div className="person-row" key={user.id}>
        <span className="person-avatar">
          {(user.displayName || user.username).slice(0, 1).toUpperCase()}
        </span>
        <PageLink
          className="person-details"
          to={"/u/" + encodeURIComponent(user.username)}
        >
          <strong>{user.displayName || user.username}</strong>
          <small>@{user.username}</small>
        </PageLink>
        {action}
      </div>
    );
  }
  return (
    <ProductShell>
      <main className="friends-main">
        <div className="product-title">
          <div>
            <div className="eyebrow">СООБЩЕСТВО</div>
            <h1>Друзья</h1>
          </div>
          <Users size={28} />
        </div>
        {loading ? (
          <p>Загрузка…</p>
        ) : !session?.user ? (
          <SignedInRequired />
        ) : (
          <>
            <form
              className="people-search"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <Search size={18} />
              <input
                aria-label="Поиск пользователей"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Имя пользователя"
                required
                maxLength={80}
              />
              <button disabled={busy}>Найти</button>
            </form>
            {results.length > 0 && (
              <section className="product-card">
                <h2>Результаты поиска</h2>
                {results.map((u) =>
                  row(
                    u,
                    u.id !== session.user?.id &&
                      !friends.some((f) => f.id === u.id) &&
                      !requests.outgoing.some((r) => r.to.id === u.id) ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate("/friend-requests", "POST", {
                            username: u.username,
                          })
                        }
                      >
                        Добавить
                      </button>
                    ) : (
                      <span className="product-muted">
                        {u.id === session.user?.id
                          ? "Это вы"
                          : friends.some((f) => f.id === u.id)
                            ? "Уже в друзьях"
                            : "Заявка отправлена"}
                      </span>
                    ),
                  ),
                )}
              </section>
            )}
            <div className="friends-columns">
              <section className="product-card" aria-busy={fetching}>
                <h2>
                  Мои друзья <small>{friends.length}</small>
                </h2>
                {friends.map((u) =>
                  row(
                    u,
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          "/friends/" + encodeURIComponent(u.id),
                          "DELETE",
                        )
                      }
                    >
                      Удалить
                    </button>,
                  ),
                )}
                {!friends.length && (
                  <p className="product-muted">
                    {fetching
                      ? "Загрузка…"
                      : "Пока никого нет. Найдите знакомых по имени пользователя."}
                  </p>
                )}
              </section>
              <div>
                <section className="product-card">
                  <h2>
                    Входящие заявки <small>{requests.incoming.length}</small>
                  </h2>
                  {requests.incoming.map((r) =>
                    row(
                      r.from,
                      <div className="person-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              "/friend-requests/" +
                                encodeURIComponent(r.id) +
                                "/accept",
                            )
                          }
                        >
                          Принять
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              "/friend-requests/" +
                                encodeURIComponent(r.id) +
                                "/decline",
                            )
                          }
                        >
                          Отклонить
                        </button>
                      </div>,
                    ),
                  )}
                  {!requests.incoming.length && (
                    <p className="product-muted">Новых заявок нет.</p>
                  )}
                </section>
                <section className="product-card">
                  <h2>Отправленные заявки</h2>
                  {requests.outgoing.map((r) =>
                    row(
                      r.to,
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            "/friend-requests/" +
                              encodeURIComponent(r.id) +
                              "/cancel",
                          )
                        }
                      >
                        Отменить
                      </button>,
                    ),
                  )}
                  {!requests.outgoing.length && (
                    <p className="product-muted">Отправленных заявок нет.</p>
                  )}
                </section>
              </div>
            </div>
          </>
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
