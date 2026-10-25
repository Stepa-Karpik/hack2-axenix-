import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { useAccount } from "./Account";
import "./github.css";

export interface GitHubStatus {
  configured: boolean;
  unavailableReason: string | null;
  linked: { login: string; githubId: string } | null;
  repositoryAccess: boolean;
  expiresAt: string | null;
}
const messages: Record<string, string> = {
  GITHUB_UNCONFIGURED:
    "GitHub пока не настроен. Нужны OAuth App и серверный ключ шифрования.",
  GITHUB_STATE_INVALID:
    "Попытка входа истекла или уже использована. Начните заново.",
  GITHUB_AUTH_DENIED: "Разрешение GitHub не предоставлено.",
  GITHUB_NOT_LINKED:
    "Не удалось завершить вход через GitHub. Попробуйте снова.",
  GITHUB_SIGNUP_INVALID:
    "Регистрация истекла или уже завершена. Начните вход через GitHub заново.",
  GITHUB_ONLY_ACCOUNT:
    "GitHub — единственный способ входа в этот аккаунт. Отключить его нельзя.",
  GITHUB_LINK_CONFLICT: "Этот GitHub уже связан с другим аккаунтом.",
  GITHUB_ACCOUNT_MISMATCH:
    "Выбран другой GitHub. Используйте привязанный аккаунт или сначала отключите связь.",
  GITHUB_SESSION_CHANGED:
    "Сессия аккаунта изменилась. Начните подключение заново.",
  GITHUB_RECONNECT: "Доступ GitHub истёк или отозван. Подключите его повторно.",
  GITHUB_SCOPE_REQUIRED: "Доступ к репозиториям не предоставлен.",
  GITHUB_REPOSITORY_ACCESS_REQUIRED:
    "Подключите доступ к репозиториям в настройках GitHub.",
  GITHUB_LINK_REQUIRED: "Сначала привяжите GitHub в настройках аккаунта.",
  GITHUB_SNAPSHOT_EXPIRED:
    "Снимок репозитория истёк или доступ изменился. Выберите версию заново.",
  GITHUB_UNAVAILABLE: "GitHub недоступен. Повторите действие позже.",
  GITHUB_ACCESS_DENIED:
    "GitHub отказал в доступе. Проверьте разрешения репозитория и организации.",
  GITHUB_TREE_INCOMPLETE:
    "GitHub вернул неполное дерево. Частичный импорт не создан.",
};
export function githubMessage(error: unknown) {
  return error instanceof ApiError
    ? (messages[error.code] ?? error.message)
    : error instanceof Error
      ? error.message
      : "Не удалось выполнить действие GitHub.";
}
export function githubCallbackMessage() {
  const code = new URLSearchParams(location.search).get("github");
  if (code === "link_success") return "GitHub привязан к вашему аккаунту.";
  if (code === "repositories_success")
    return "Доступ к репозиториям подключён.";
  return code && Object.hasOwn(messages, code) ? messages[code] : "";
}
export function useGitHubStatus() {
  const { session } = useAccount();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setError("");
    api<GitHubStatus>("/github/status", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(githubMessage(error));
      });
    return () => controller.abort();
  }, [session?.user?.id, reload]);
  return { status, error, refresh: () => setReload((value) => value + 1) };
}
export async function startGitHub(
  purpose: "link" | "login" | "repositories",
  signal?: AbortSignal,
) {
  const result = await api<{ authorizationUrl: string }>(
    "/github/oauth/start",
    { method: "POST", body: { purpose }, signal },
  );
  const url = new URL(result.authorizationUrl);
  if (
    url.origin !== "https://github.com" ||
    url.pathname !== "/login/oauth/authorize" ||
    url.username ||
    url.password
  )
    throw new Error("Сервер вернул недопустимый адрес GitHub.");
  return url.href;
}
export function useGitHubRedirect() {
  const { session } = useAccount();
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true),
    locked = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    locked.current = false;
    setBusy(false);
    setError("");
  }, [session?.user?.id]);
  async function start(purpose: "link" | "login" | "repositories") {
    if (locked.current) return;
    locked.current = true;
    const ticket = epoch.current;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError("");
    try {
      const url = await startGitHub(purpose, current.signal);
      if (mounted.current && ticket === epoch.current) location.assign(url);
    } catch (error) {
      if (mounted.current && ticket === epoch.current)
        setError(githubMessage(error));
    } finally {
      if (mounted.current && ticket === epoch.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return { busy, error, start };
}
