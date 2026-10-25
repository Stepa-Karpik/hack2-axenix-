import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import AuthFrame from "./AuthFrame";
import { authLink, authReturn } from "./authNavigation";
import { api } from "./api";
import { accountError, go, PageLink, useAccount } from "./Account";
import type { ReactNode } from "react";
type AuthMode =
  "login" | "register" | "forgot-password" | "reset-password" | "verify-email";
const headings: Record<AuthMode, string> = {
  login: "С возвращением",
  register: "Создайте аккаунт",
  "forgot-password": "Восстановление доступа",
  "reset-password": "Новый пароль",
  "verify-email": "Подтвердите почту",
};
export default function AccountAuth({
  mode,
  githubLogin,
}: {
  mode: AuthMode;
  githubLogin?: ReactNode;
}) {
  const { refresh } = useAccount();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState("");
  const locked = useRef(false);
  const [token, setToken] = useState(
    () =>
      new URLSearchParams(location.search).get("token") ??
      new URLSearchParams(location.hash.slice(1)).get("token") ??
      "",
  );
  async function submit(form: HTMLFormElement) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setResult("");
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? "");
    try {
      if (mode === "login") {
        await api("/auth/login", {
          method: "POST",
          body: {
            identifier: value("identifier"),
            password: value("password"),
          },
        });
        await refresh();
        go(authReturn());
      } else if (mode === "register") {
        const r = await api<{ emailDelivery: boolean }>("/auth/register", {
          method: "POST",
          body: {
            username: value("username"),
            email: value("email"),
            password: value("password"),
          },
        });
        await refresh();
        setResult(
          r.emailDelivery
            ? "Аккаунт создан. Откройте ссылку в письме, чтобы подтвердить почту."
            : "Аккаунт создан. Отправка почты на сервере недоступна; письмо подтверждения не отправлено.",
        );
      } else if (mode === "forgot-password") {
        await api("/auth/forgot-password", {
          method: "POST",
          body: { email: value("email") },
        });
        setResult(
          "Если аккаунт с этой почтой существует, ссылка для восстановления отправлена.",
        );
      } else if (mode === "reset-password") {
        await api("/auth/reset-password", {
          method: "POST",
          body: { token, password: value("password") },
        });
        setResult("Пароль изменён. Войдите с новым паролем.");
      } else {
        await api("/auth/verify-email", { method: "POST", body: { token } });
        await refresh();
        setResult("Почта подтверждена.");
      }
    } catch (e) {
      setError(accountError(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <h2>{headings[mode]}</h2>
      <p className="product-muted">
        {mode === "login"
          ? "Продолжите работу со своими проектами."
          : mode === "register"
            ? "Сохраняйте проекты и работайте вместе."
            : mode === "verify-email"
              ? "Откройте ссылку из письма для подтверждения."
              : "Используйте почту вашего аккаунта."}
      </p>
      <form
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        <fieldset disabled={busy}>
          {mode === "register" && (
            <label>
              Имя пользователя
              <input
                name="username"
                required
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_]+"
                autoComplete="username"
                placeholder="username"
              />
            </label>
          )}
          {mode === "login" && (
            <label>
              Почта или имя пользователя
              <input
                name="identifier"
                required
                maxLength={254}
                autoComplete="username"
              />
            </label>
          )}
          {(mode === "register" || mode === "forgot-password") && (
            <label>
              Электронная почта
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
          )}
          {(mode === "reset-password" || mode === "verify-email") && (
            <label>
              Код из ссылки
              <input
                name="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {(mode === "login" ||
            mode === "register" ||
            mode === "reset-password") && (
            <label>
              Пароль
              <input
                name="password"
                aria-label="Пароль"
                aria-describedby={
                  mode === "login" ? undefined : "auth-password-hint"
                }
                type="password"
                required
                minLength={mode === "login" ? 1 : 12}
                maxLength={256}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
              {mode !== "login" && (
                <small id="auth-password-hint">Не менее 12 символов.</small>
              )}
            </label>
          )}
          {mode === "login" && (
            <PageLink to={authLink("/forgot-password")} className="auth-forgot">
              Забыли пароль?
            </PageLink>
          )}
          <button className="product-action" type="submit">
            {busy
              ? "Подождите…"
              : mode === "login"
                ? "Войти"
                : mode === "register"
                  ? "Создать аккаунт"
                  : mode === "verify-email"
                    ? "Подтвердить почту"
                    : mode === "reset-password"
                      ? "Изменить пароль"
                      : "Отправить ссылку"}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </fieldset>
      </form>
      {error && (
        <p className="product-feedback error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="product-feedback" role="status">
          {result}
        </p>
      )}
      {githubLogin && (mode === "login" || mode === "register") && (
        <div className="auth-provider">
          <div className="auth-divider">
            <span>или</span>
          </div>
          {githubLogin}
        </div>
      )}
      <div className="auth-footer">
        {mode === "login" ? (
          <>
            Нет аккаунта?{" "}
            <PageLink to={authLink("/register")}>Зарегистрироваться</PageLink>
          </>
        ) : (
          <>
            <span>{mode === "register" ? "Уже есть аккаунт? " : ""}</span>
            <PageLink to={authLink("/login")}>Войти</PageLink>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
