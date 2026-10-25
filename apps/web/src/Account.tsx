import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, MouseEvent } from "react";
import { api, ApiError, setSessionCsrf } from "./api";
import "./account-pages.css";
export interface AccountUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  email?: string;
  emailVerified?: boolean;
}
export interface AccountSession {
  mode: string;
  csrfToken: string;
  user: AccountUser | null;
  capabilities: {
    registration: boolean;
    emailDelivery: boolean;
    legacyGuestWorkspace: boolean;
    projectCreation?: boolean;
    projectExport?: boolean;
  };
}
export function canCreateProjects(session: AccountSession | null) {
  return (
    !!session &&
    (session.capabilities.projectCreation ??
      (!!session.user || session.capabilities.legacyGuestWorkspace))
  );
}
export function canExportProjects(session: AccountSession | null) {
  return (
    !!session &&
    (session.capabilities.projectExport ??
      (!!session.user || session.capabilities.legacyGuestWorkspace))
  );
}
const AccountContext = createContext<{
  session: AccountSession | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}>({ session: null, loading: true, error: "", refresh: async () => {} });
export function AccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AccountSession | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const generation = useRef(0);
  async function refresh() {
    const ticket = ++generation.current;
    try {
      const next = await api<AccountSession>("/session");
      if (ticket !== generation.current) return;
      setSessionCsrf(next.csrfToken);
      setSession(next);
      setError("");
    } catch (e) {
      if (ticket === generation.current) setError(accountError(e));
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, []);
  return (
    <AccountContext.Provider value={{ session, loading, error, refresh }}>
      {children}
    </AccountContext.Provider>
  );
}
export const useAccount = () => useContext(AccountContext);
const accountMessages: Record<string, string> = {
  INVALID_CREDENTIALS: "Неверная почта, имя пользователя или пароль.",
  INVALID_PASSWORD: "Пароль должен содержать от 12 до 256 символов.",
  INVALID_USERNAME:
    "Имя пользователя: от 3 до 32 латинских букв, цифр или символов подчёркивания.",
  INVALID_EMAIL: "Проверьте адрес электронной почты.",
  ACCOUNT_CONFLICT: "Это имя пользователя или почта уже заняты.",
  AUTH_REQUIRED: "Войдите в аккаунт, чтобы продолжить.",
  TOKEN_INVALID: "Ссылка недействительна или срок её действия истёк.",
  CREDENTIALS_CHANGED:
    "Пароль уже изменён. Повторите вход или запросите новую ссылку.",
  SMTP_UNAVAILABLE: "Отправка писем пока недоступна. Попробуйте позже.",
  RATE_LIMITED: "Слишком много попыток. Попробуйте через 15 минут.",
  ACCESS_DENIED: "У вас нет доступа к этому действию.",
  PIN_OWNER_REQUIRED: "Закреплять можно только собственные проекты.",
  OWNER_REQUIRED: "Доступом к проекту управляет его владелец.",
  FRIEND_REQUIRED: "Сначала добавьте этого пользователя в друзья.",
  ALREADY_FRIENDS: "Вы уже в друзьях.",
  REQUEST_EXISTS: "Заявка в друзья уже отправлена.",
  NOT_FOUND: "Запрошенные данные не найдены.",
  INVALID_REQUEST: "Проверьте введённые данные.",
  CSRF_INVALID: "Обновите страницу и повторите действие.",
};
export const accountError = (e: unknown) =>
  e instanceof ApiError && accountMessages[e.code]
    ? accountMessages[e.code]
    : e instanceof Error
      ? e.message
      : "Не удалось выполнить действие";
export function go(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function PageLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
          e.preventDefault();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}
export function ProductBrand() {
  return (
    <PageLink to="/" className="product-brand">
      <span className="product-brand-mark">
        <img src="/brand-lockup.png" alt="JB" />
      </span>
      <span>
        Java<span>Blueprints</span>
      </span>
    </PageLink>
  );
}
export function AccountNav() {
  const { session, loading } = useAccount();
  return (
    <nav className="account-nav" aria-label="Аккаунт">
      {session?.user ? (
        <>
          <PageLink to="/friends">Друзья</PageLink>
          <PageLink to="/settings/profile">Настройки</PageLink>
          <PageLink
            className="account-avatar-link"
            to={"/u/" + encodeURIComponent(session.user.username)}
          >
            <span className="mini-avatar">
              {(session.user.displayName || session.user.username)
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span>{session.user.username}</span>
          </PageLink>
        </>
      ) : (
        <PageLink className="account-signin" to="/login">
          {loading ? "Аккаунт…" : "Войти"}
        </PageLink>
      )}
    </nav>
  );
}
export function ProductShell({ children }: { children: ReactNode }) {
  const { error, refresh } = useAccount();
  return (
    <div className="product-page">
      <header className="product-header">
        <ProductBrand />
        <AccountNav />
      </header>
      {error && (
        <div className="product-feedback error" role="alert">
          {error}
          <button onClick={() => void refresh()}>Повторить</button>
        </div>
      )}
      <div className="product-body">
        <ProductSidebar />
        <div className="product-content">{children}</div>
      </div>
    </div>
  );
}
export function SignedInRequired() {
  return (
    <div className="product-empty">
      <h1>Войдите в аккаунт</h1>
      <p>Профиль и друзья доступны после входа.</p>
      <PageLink className="product-action" to="/login">
        Войти
      </PageLink>
    </div>
  );
}

export function ProductSidebar({ active }: { active?: string }) {
  const { session } = useAccount();
  const path = active ?? location.pathname;
  const links = [
    ["/", "Проекты"],
    ...(session?.user
      ? [["/u/" + encodeURIComponent(session.user.username), "Мой профиль"]]
      : []),
    ["/settings/profile", "Профиль"],
    ["/settings/security", "Безопасность"],
    ["/settings/appearance", "Оформление"],
    ["/settings/friends", "Друзья"],
    ["/settings/integrations", "Интеграции"],
  ];
  return (
    <aside className="product-sidebar" data-tour="navigation">
      <nav aria-label="Разделы приложения">
        {links.map(([to, label]) => (
          <PageLink
            key={to}
            to={to}
            className={path === to ? "active" : undefined}
          >
            {label}
          </PageLink>
        ))}
      </nav>
    </aside>
  );
}
