import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAccount } from "./Account";
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
  const [consent, setConsent] = useState(false),
    [confirm, setConfirm] = useState(false),
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
    setConsent(false);
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
        setConsent(false);
        setResult(
          "Связь удалена из приложения. Разрешение OAuth App можно отдельно отозвать в настройках GitHub.",
        );
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
  return (
    <section
      className="github-settings"
      aria-labelledby="github-settings-title"
    >
      <h2 id="github-settings-title">GitHub</h2>
      {!status && !error && <p role="status">Проверяем подключение…</p>}
      {status && !status.configured && (
        <p role="status">{status.unavailableReason}</p>
      )}
      {status?.linked ? (
        <>
          <p>
            Привязан <strong>{status.linked.login}</strong>{" "}
            <span className="quiet">· ID {status.linked.githubId}</span>
          </p>
          <p className="quiet">
            {status.repositoryAccess
              ? "Доступ к репозиториям подключён."
              : "Доступ к репозиториям ещё не подключён."}
            {status.expiresAt
              ? " Срок: " + new Date(status.expiresAt).toLocaleString()
              : ""}
          </p>
          {
            <>
              <p className="quiet small">
                Для приватных репозиториев GitHub OAuth запрашивает широкое
                разрешение repo, включающее запись. Это приложение использует
                его для чтения. Доступ организации может потребовать отдельного
                одобрения.
              </p>
              <label className="github-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy || redirect.busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                Разрешить подключение репозиториев с разрешением repo
              </label>
              <button
                type="button"
                disabled={
                  !status.configured || !consent || busy || redirect.busy
                }
                onClick={() => void redirect.start("repositories")}
              >
                {status.repositoryAccess
                  ? "Переподключить репозитории GitHub"
                  : "Подключить репозитории GitHub"}
              </button>
            </>
          }
          {!confirm ? (
            <button
              type="button"
              disabled={busy || redirect.busy}
              onClick={() => setConfirm(true)}
            >
              Отключить GitHub
            </button>
          ) : (
            <div className="github-actions">
              <span>Отключить вход GitHub и импорт репозиториев?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void unlink()}
              >
                Да, отключить
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Отмена
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="quiet">
            Привяжите GitHub к существующему аккаунту для последующего входа.
            Почта GitHub не используется для объединения аккаунтов.
          </p>
          <button
            type="button"
            disabled={!status?.configured || redirect.busy}
            onClick={() => void redirect.start("link")}
          >
            Привязать GitHub
          </button>
        </>
      )}
      {(error || actionError || redirect.error) && (
        <p role="alert">{error || actionError || redirect.error}</p>
      )}
      {(result || githubCallbackMessage()) && (
        <p role="status">{result || githubCallbackMessage()}</p>
      )}
    </section>
  );
}
