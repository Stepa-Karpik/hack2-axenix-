import {
  useGitHubRedirect,
  useGitHubStatus,
  githubCallbackMessage,
} from "./github";
export default function GitHubLoginButton() {
  const { status, error } = useGitHubStatus();
  const redirect = useGitHubRedirect();
  const reason = status && !status.configured ? status.unavailableReason : "";
  return (
    <div className="github-connection">
      <button
        type="button"
        className="github-login"
        disabled={!status?.configured || redirect.busy}
        onClick={() => void redirect.start("login")}
      >
        Войти через GitHub
      </button>
      <p className="quiet small">
        Для GitHub, ранее привязанного к вашему аккаунту.
      </p>
      {(reason || error || redirect.error || githubCallbackMessage()) && (
        <p role="status" className="quiet small">
          {reason || error || redirect.error || githubCallbackMessage()}
        </p>
      )}
    </div>
  );
}
