import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  accountError,
  PageLink,
  ProductShell,
  SignedInRequired,
  useAccount,
} from "./Account";
import { useTheme } from "./theme";
export default function SettingsPage() {
  const { session, loading, refresh } = useAccount();
  const { theme, toggle } = useTheme();
  const user = session?.user;
  const [displayName, setDisplayName] = useState(""),
    [bio, setBio] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
  }, [user?.id, user?.displayName, user?.bio]);
  async function action(kind: string, body: unknown) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(kind);
    setError("");
    setResult("");
    try {
      const response = await api<{ sent?: boolean; alreadyVerified?: boolean }>(
        kind === "profile" ? "/profile" : "/auth/" + kind,
        {
          method: kind === "profile" ? "PATCH" : "POST",
          body,
        },
      );
      await refresh();
      setResult(
        kind === "profile"
          ? "Профиль сохранён на сервере."
          : kind === "resend-verification"
            ? response.sent
              ? "Письмо подтверждения отправлено."
              : "Почта уже подтверждена."
            : kind === "logout"
              ? "Вы вышли из аккаунта."
              : "Пароль изменён. Войдите заново, если сессия завершена.",
      );
      return true;
    } catch (e) {
      setError(accountError(e));
      return false;
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  return (
    <ProductShell>
      <main className="settings-main">
        <div className="product-title">
          <div>
            <div className="eyebrow">АККАУНТ</div>
            <h1>Настройки</h1>
          </div>
          {user && (
            <PageLink to={"/u/" + encodeURIComponent(user.username)}>
              Открыть профиль ↗
            </PageLink>
          )}
        </div>
        {loading ? (
          <p>Загрузка…</p>
        ) : !user ? (
          <SignedInRequired />
        ) : (
          <div className="settings-layout">
            <aside className="settings-nav">
              <a href="#profile">Профиль</a>
              <a href="#security">Безопасность</a>
              <a href="#appearance">Оформление</a>
              <PageLink to="/friends">Друзья</PageLink>
            </aside>
            <div className="settings-sections">
              <section id="profile" className="product-card">
                <h2>Публичный профиль</h2>
                <p className="product-muted">@{user.username}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action("profile", { displayName, bio });
                  }}
                >
                  <fieldset disabled={!!busy}>
                    <label>
                      Имя
                      <input
                        required
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        maxLength={80}
                      />
                    </label>
                    <label>
                      О себе
                      <textarea
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        maxLength={500}
                        rows={4}
                      />
                    </label>
                    <button className="product-action">
                      {busy === "profile" ? "Сохранение…" : "Сохранить профиль"}
                    </button>
                  </fieldset>
                </form>
              </section>
              <section id="security" className="product-card">
                <h2>Безопасность</h2>
                <div className="setting-row">
                  <div>
                    <strong>{user.email}</strong>
                    <p className="product-muted">
                      {user.emailVerified
                        ? "Почта подтверждена"
                        : "Почта не подтверждена"}
                    </p>
                  </div>
                  {!user.emailVerified && (
                    <button
                      disabled={!!busy}
                      onClick={() => void action("resend-verification", {})}
                    >
                      Отправить письмо
                    </button>
                  )}
                </div>
                {!user.emailVerified &&
                  session?.capabilities.emailDelivery === false && (
                    <p className="product-muted">
                      Отправка почты пока не настроена на сервере.
                    </p>
                  )}
                <form
                  onChange={() => {
                    setError("");
                    setResult("");
                  }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const d = new FormData(form);
                    setError("");
                    setResult("");
                    if (d.get("newPassword") !== d.get("confirmPassword")) {
                      setError("Новые пароли не совпадают.");
                      return;
                    }
                    void action("change-password", {
                      currentPassword: d.get("currentPassword"),
                      newPassword: d.get("newPassword"),
                    }).then((saved) => {
                      if (saved) form.reset();
                    });
                  }}
                >
                  <fieldset disabled={!!busy}>
                    <label>
                      Текущий пароль
                      <input
                        name="currentPassword"
                        maxLength={256}
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </label>
                    <label>
                      Новый пароль
                      <input
                        name="newPassword"
                        aria-label="Новый пароль"
                        aria-describedby="settings-password-hint"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required
                      />
                      <small id="settings-password-hint">
                        От 12 до 256 символов.
                      </small>
                    </label>
                    <label>
                      Повторите пароль
                      <input
                        name="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required
                      />
                    </label>
                    <button>Изменить пароль</button>
                  </fieldset>
                </form>
              </section>
              <section id="appearance" className="product-card">
                <h2>Оформление</h2>
                <div className="setting-row">
                  <div>
                    <strong>
                      {theme === "dark" ? "Тёмная тема" : "Светлая тема"}
                    </strong>
                    <p className="product-muted">
                      Сохраняется только в этом браузере.
                    </p>
                  </div>
                  <button onClick={toggle}>Переключить тему</button>
                </div>
              </section>
              <button
                className="settings-logout"
                disabled={!!busy}
                onClick={() => void action("logout", {})}
              >
                Выйти из аккаунта
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="product-feedback error">
            {error}
          </p>
        )}
        {result && (
          <p role="status" className="product-feedback">
            {result}
          </p>
        )}
      </main>
    </ProductShell>
  );
}
