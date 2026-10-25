import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  accountError,
  PageLink,
  ProductShell,
  SignedInRequired,
  useAccount,
} from "./Account";
import type { ReactNode } from "react";
import { AppearanceSettings } from "./AppearanceSettings";
import { FriendsContent } from "./FriendsPage";
import AvatarUpload from "./AvatarUpload";
export type SettingsSection =
  "profile" | "security" | "appearance" | "friends" | "integrations";
export default function SettingsPage({
  section = "profile",
  integrations,
}: {
  section?: SettingsSection;
  integrations?: ReactNode;
}) {
  const { session, loading, refresh } = useAccount();

  const user = session?.user;
  const [displayName, setDisplayName] = useState(""),
    [bio, setBio] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState("");
  const lock = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setError("");
    setResult("");
    setBusy("");
    lock.current = false;
    return () => {
      epoch.current++;
    };
  }, [user?.id, section]);
  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
  }, [user?.id, user?.displayName, user?.bio]);
  async function action(kind: string, body: unknown) {
    if (lock.current) return false;
    const ticket = epoch.current;
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
      if (ticket !== epoch.current) return false;
      await refresh();
      if (ticket !== epoch.current) return false;
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
      if (ticket === epoch.current) setError(accountError(e));
      return false;
    } finally {
      if (ticket === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  return (
    <ProductShell>
      <main className="settings-main">
        <div className="product-title">
          <div>
            <h1>
              {
                {
                  profile: "Профиль",
                  security: "Безопасность",
                  appearance: "Оформление",
                  friends: "Друзья",
                  integrations: "Интеграции",
                }[section]
              }
            </h1>
          </div>
          {user && (
            <PageLink to={"/u/" + encodeURIComponent(user.username)}>
              Открыть профиль ↗
            </PageLink>
          )}
        </div>
        {section === "appearance" ? (
          <AppearanceSettings />
        ) : loading ? (
          <p>Загрузка…</p>
        ) : !user ? (
          <SignedInRequired />
        ) : (
          <div className="settings-layout">
            <div className="settings-sections">
              {section === "profile" && (
                <section id="profile" className="product-card">
                  <h2>Публичный профиль</h2>
                  <p className="product-muted">@{user.username}</p>
                  <AvatarUpload />
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
                        {busy === "profile"
                          ? "Сохранение…"
                          : "Сохранить профиль"}
                      </button>
                    </fieldset>
                  </form>
                </section>
              )}
              {section === "security" && (
                <section id="security" className="product-card">
                  <h2>Безопасность</h2>
                  {user.authMethod === "github" ? (
                    <div className="setting-row">
                      <div>
                        <strong>Вход через GitHub</strong>
                        <p className="product-muted">
                          Этот аккаунт создан через GitHub. Для входа
                          используйте GitHub.
                        </p>
                      </div>
                      <PageLink
                        className="product-outline"
                        to="/settings/integrations"
                      >
                        Подключение GitHub
                      </PageLink>
                    </div>
                  ) : (
                    <>
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
                            onClick={() =>
                              void action("resend-verification", {})
                            }
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
                          if (
                            d.get("newPassword") !== d.get("confirmPassword")
                          ) {
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
                    </>
                  )}
                </section>
              )}
              {section === "friends" && <FriendsContent />}
              {section === "integrations" && (
                <section className="product-card">
                  {integrations ?? <p>Интеграции пока недоступны.</p>}
                </section>
              )}
              {section === "security" && (
                <button
                  className="settings-logout"
                  disabled={!!busy}
                  onClick={() => void action("logout", {})}
                >
                  Выйти из аккаунта
                </button>
              )}
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
