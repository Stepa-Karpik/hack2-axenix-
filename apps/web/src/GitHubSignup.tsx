import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, ApiError } from "./api";
import { accountError, PageLink, useAccount } from "./Account";
import AuthFrame from "./AuthFrame";
import GitHubIcon from "./GitHubIcon";
import { githubMessage } from "./github";

type PendingSignup = {
  githubLogin: string;
  suggestedUsername: string;
  expiresAt: string;
};

export default function GitHubSignup() {
  const { refresh } = useAccount();
  const [pending, setPending] = useState<PendingSignup | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api<PendingSignup>("/github/signup", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setPending(data);
          setUsername(data.suggestedUsername);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(githubMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);
  async function submit() {
    if (locked.current || !pending) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/github/signup", {
        method: "POST",
        body: { username: username.trim() },
      });
      if (!mounted.current) return;
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof ApiError && cause.code === "INVALID_USERNAME"
            ? "От 1 до 39 латинских букв, цифр, дефисов или подчёркиваний. Первый символ — буква или цифра."
            : accountError(cause),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <div className="auth-provider-badge">
        <GitHubIcon /> GitHub{pending ? " · @" + pending.githubLogin : ""}
      </div>
      <h2>Выберите имя</h2>
      <p className="product-muted">
        Имя из GitHub уже занято. Укажите другое для JavaBlueprints.
      </p>
      {loading && <p role="status">Проверяем регистрацию…</p>}
      {pending && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          aria-busy={busy}
        >
          <fieldset disabled={busy}>
            <label>
              Имя пользователя
              <input
                name="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
                minLength={1}
                maxLength={39}
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
                aria-describedby="github-username-hint"
              />
            </label>
            <small id="github-username-hint" className="product-muted">
              Латинские буквы, цифры, дефис и подчёркивание.
            </small>
            <button type="submit" className="product-action">
              {busy ? "Создаём аккаунт…" : "Создать аккаунт"}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p className="product-feedback error" role="alert">
          {error}
        </p>
      )}
      <div className="auth-footer">
        <PageLink to="/login">Вернуться ко входу</PageLink>
      </div>
    </AuthFrame>
  );
}
