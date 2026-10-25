import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ArrowUpRight, Check, Unplug } from "lucide-react";
import GitHubIcon from "./GitHubIcon";
import { PageLink, useAccount } from "./Account";
import {
  githubCallbackMessage,
  githubMessage,
  useGitHubRedirect,
  useGitHubStatus,
} from "./github";
export default function GitHubSettings() {
  const { session } = useAccount();
  const { status, error, refresh } = useGitHubStatus();
  const redirect = useGitHubRedirect();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [result, setResult] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    locked.current = false;
    setBusy(false);
    setConfirm(false);
    setResult("");
    setActionError("");
  }, [session?.user?.id]);
  async function unlink() {
    if (locked.current) return;
    locked.current = true;
    const ticket = epoch.current;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setActionError("");
    try {
      await api("/github/link", { method: "DELETE", signal: current.signal });
      if (mounted.current && ticket === epoch.current) {
        setConfirm(false);
        setResult("GitHub отключён.");
        refresh();
      }
    } catch (error) {
      if (mounted.current && ticket === epoch.current)
        setActionError(githubMessage(error));
    } finally {
      if (mounted.current && ticket === epoch.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  if (!session?.user) return <p>Войдите в аккаунт, чтобы подключить GitHub.</p>;
  const connected = !!status?.linked && status.repositoryAccess;
  const callback = new URLSearchParams(location.search).get("github");
  const feedback =
    result || (callback?.endsWith("_success") ? "" : githubCallbackMessage());
  return (
    <section
      data-assistant-target="integrations"
      className="github-settings integration-card"
      aria-labelledby="github-settings-title"
    >
      <div className="integration-heading">
        <span className="integration-logo">
          <GitHubIcon size={28} />
        </span>
        <div className="integration-title">
          <h2 id="github-settings-title">GitHub</h2>
          <p>Репозитории и импорт проектов</p>
        </div>
        <span
          data-assistant-target={connected ? "github-control" : undefined}
          className="integration-status"
          data-connected={connected}
        >
          <i aria-hidden="true" />
          {connected
            ? "Подключено"
            : status?.linked
              ? "Нужен доступ"
              : "Не подключено"}
        </span>
      </div>
      {status?.linked ? (
        <div className="integration-account">
          <div>
            <span className="integration-caption">Аккаунт</span>
            <strong>@{status.linked.login}</strong>
          </div>
          {connected && (
            <div className="integration-features">
              <span>
                <Check size={14} /> Импорт репозиториев
              </span>
              <span>
                <Check size={14} /> Приватные проекты
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="integration-description">
          Подключите GitHub, чтобы импортировать публичные и приватные
          репозитории.
        </p>
      )}
      <div className="integration-controls">
        {connected ? (
          <PageLink to="/projects" className="product-action">
            Открыть проекты
            <ArrowUpRight size={16} />
          </PageLink>
        ) : (
          <button
            data-assistant-target="github-control"
            className="product-action"
            type="button"
            disabled={!status?.configured || busy || redirect.busy}
            onClick={() =>
              void redirect.start(status?.linked ? "repositories" : "link")
            }
          >
            {redirect.busy
              ? "Подключение…"
              : status?.linked
                ? "Обновить доступ"
                : "Подключить GitHub"}
            <ArrowUpRight size={16} />
          </button>
        )}
        {status?.linked && session.user.authMethod !== "github" && !confirm && (
          <button
            className="integration-disconnect"
            type="button"
            disabled={busy || redirect.busy}
            onClick={() => setConfirm(true)}
          >
            <Unplug size={15} />
            Отключить GitHub
          </button>
        )}
        {status?.linked && session.user.authMethod === "github" && (
          <span className="integration-login-note">Используется для входа</span>
        )}
      </div>
      {confirm && (
        <div className="integration-confirm">
          <p>Отключить GitHub?</p>
          <div className="github-actions">
            <button
              type="button"
              className="integration-disconnect"
              disabled={busy}
              onClick={() => void unlink()}
            >
              {busy ? "Отключение…" : "Да, отключить"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      {!status && !error && (
        <p className="integration-feedback" role="status">
          Проверяем подключение…
        </p>
      )}
      {status && !status.configured && (
        <p className="integration-feedback" role="status">
          Подключение GitHub пока недоступно.
        </p>
      )}
      {(error || actionError || redirect.error) && (
        <p className="integration-feedback error" role="alert">
          {error || actionError || redirect.error}
        </p>
      )}
      {feedback && (
        <p className="integration-feedback" role="status">
          {feedback}
        </p>
      )}
    </section>
  );
}
