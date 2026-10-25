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
export function FriendsContent() {
  const { session } = useAccount();
  return <FriendsManager key={session?.user?.id ?? "guest"} />;
}
function FriendsManager() {
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
  const searchEpoch = useRef(0);
  async function load() {
    const ticket = epoch.current;
    setFetching(true);
    try {
      const [f, r] = await Promise.all([
        api<AccountUser[]>("/friends"),
        api<typeof requests>("/friend-requests"),
      ]);
      if (ticket !== epoch.current) return;
      setFriends(f);
      setRequests(r);
      setError("");
    } catch (e) {
      if (ticket === epoch.current) setError(accountError(e));
    } finally {
      if (ticket === epoch.current) setFetching(false);
    }
  }
  useEffect(() => {
    epoch.current++;
    setFriends([]);
    setRequests({ incoming: [], outgoing: [] });
    setResults([]);
    setError("");
    if (session?.user) void load();
    return () => {
      epoch.current++;
    };
  }, [session?.user?.id]);
  async function mutate(path: string, method = "POST", body: unknown = {}) {
    const ticket = epoch.current;
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body });
      if (ticket === epoch.current) await load();
    } catch (e) {
      if (ticket === epoch.current) setError(accountError(e));
    } finally {
      if (ticket === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function search() {
    if (lock.current) return;
    lock.current = true;
    const current = ++searchEpoch.current,
      identity = epoch.current;
    setBusy(true);
    setError("");
    try {
      const users = await api<AccountUser[]>(
        "/users?q=" + encodeURIComponent(query.trim()),
      );
      if (current === searchEpoch.current && identity === epoch.current)
        setResults(users);
    } catch (e) {
      if (current === searchEpoch.current && identity === epoch.current)
        setError(accountError(e));
    } finally {
      if (current === searchEpoch.current && identity === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
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
    <div className="friends-content">
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
    </div>
  );
}

export default function FriendsPage({ username }: { username?: string }) {
  return (
    <ProductShell>
      <main className="friends-main">
        {username ? (
          <PublicFriends key={username} username={username} />
        ) : (
          <FriendsContent />
        )}
      </main>
    </ProductShell>
  );
}
function PublicFriends({ username }: { username: string }) {
  const { session } = useAccount();
  const [data, setData] = useState<{
    items: AccountUser[];
    count: number;
    mutualCount: number;
    nextOffset: number | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const searchEpoch = useRef(0);
  useEffect(() => {
    const ticket = ++epoch.current;
    setData(null);
    setError("");
    api<{
      items: AccountUser[];
      count: number;
      mutualCount: number;
      nextOffset: number | null;
    }>("/users/" + encodeURIComponent(username) + "/friends")
      .then((d) => {
        if (ticket === epoch.current) setData(d);
      })
      .catch((e) => {
        if (ticket === epoch.current) setError(accountError(e));
      });
    return () => {
      epoch.current++;
    };
  }, [username, session?.user?.id]);
  async function more() {
    if (busy || data?.nextOffset == null) return;
    const ticket = epoch.current;
    setBusy(true);
    try {
      const d = await api<NonNullable<typeof data>>(
        "/users/" +
          encodeURIComponent(username) +
          "/friends?offset=" +
          data.nextOffset,
      );
      if (ticket === epoch.current)
        setData((old) =>
          old ? { ...d, items: [...old.items, ...d.items] } : d,
        );
    } catch (e) {
      if (ticket === epoch.current) setError(accountError(e));
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }
  return (
    <>
      <h1>Друзья @{username}</h1>
      {data && (
        <>
          <p className="product-muted">
            {data.count} друзей
            {session?.user && session.user.username !== username
              ? ` · ${data.mutualCount} общих`
              : ""}
          </p>
          <section className="product-card">
            {data.items.map((u) => (
              <div className="person-row" key={u.id}>
                <span className="person-avatar">
                  {(u.displayName || u.username).slice(0, 1).toUpperCase()}
                </span>
                <PageLink
                  className="person-details"
                  to={"/u/" + encodeURIComponent(u.username)}
                >
                  <strong>{u.displayName || u.username}</strong>
                  <small>@{u.username}</small>
                </PageLink>
              </div>
            ))}
            {!data.count && <p>Список друзей пока пуст.</p>}
            {data.nextOffset !== null && (
              <button disabled={busy} onClick={() => void more()}>
                Показать ещё
              </button>
            )}
          </section>
        </>
      )}
      {!data && !error && <p>Загрузка…</p>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
