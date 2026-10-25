import { useRef, useState } from "react";
import { ArrowUpRight, Code2, GitBranch, Workflow } from "lucide-react";
import { api } from "./api";
import {
  accountError,
  go,
  PageLink,
  ProductBrand,
  useAccount,
} from "./Account";
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
        go("/");
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
    <div className="product-page auth-page">
      <header className="product-header">
        <ProductBrand />
      </header>
      <main className="auth-layout">
        <section className="auth-story">
          <div className="eyebrow">JAVA BLUEPRINTS</div>
          <h1>
            От идеи
            <br />к ясной структуре.
          </h1>
          <p>Код, граф и проверка — в одном рабочем пространстве.</p>
          <div className="auth-composition" aria-hidden="true">
            <div className="composition-tab">
              <Code2 size={17} /> Main.java <span>Java 21</span>
            </div>
            <pre>
              <span>public</span> int find(int[] values, int target) {"{"}
              <br /> <span>for</span> (int i = 0; i &lt; values.length; i++){" "}
              {"{"}
              <br /> <span>if</span> (values[i] == target) return i;
              <br /> {"}"}
              <br /> return -1;
              <br />
              {"}"}
            </pre>
            <div className="composition-flow">
              <span>
                <Workflow size={19} /> Структура
              </span>
              <i />
              <span>
                <GitBranch size={19} /> Условие
              </span>
              <i />
              <span>
                <ArrowUpRight size={19} /> Результат
              </span>
            </div>
          </div>
          <small>Java 21 · визуальная работа с кодом</small>
        </section>
        <section className="auth-form-panel">
          <div className="auth-form-wrap">
            <h2>{headings[mode]}</h2>
            {mode === "login" && githubLogin}
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
                      <small id="auth-password-hint">
                        Не менее 12 символов.
                      </small>
                    )}
                  </label>
                )}
                {mode === "login" && (
                  <PageLink to="/forgot-password" className="auth-forgot">
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
                  <ArrowUpRight size={16} />
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
            <div className="auth-footer">
              {mode === "login" ? (
                <>
                  Нет аккаунта?{" "}
                  <PageLink to="/register">Зарегистрироваться</PageLink>
                </>
              ) : (
                <PageLink to="/login">Перейти ко входу</PageLink>
              )}
              <PageLink to="/">Открыть рабочее пространство</PageLink>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
