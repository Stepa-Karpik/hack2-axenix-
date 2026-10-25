import {
  useGitHubRedirect,
  useGitHubStatus,
  githubCallbackMessage,
} from "./github";
import GitHubIcon from "./GitHubIcon";
import { rememberAuthReturn } from "./authNavigation";
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
        onClick={() => {
          rememberAuthReturn();
          void redirect.start("login");
        }}
      >
        <GitHubIcon />
        {redirect.busy ? "Переходим в GitHub…" : "Продолжить с GitHub"}
      </button>
      {(reason || error || redirect.error || githubCallbackMessage()) && (
        <p role="status" className="quiet small">
          {reason || error || redirect.error || githubCallbackMessage()}
        </p>
      )}
    </div>
  );
}
