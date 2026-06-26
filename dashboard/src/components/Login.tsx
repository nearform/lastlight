import { useState } from "react";
import { api, auth } from "../api";

interface Props {
  onAuthed: () => void;
  slackOAuth?: boolean;
  githubOAuth?: boolean;
  /** Whether password login is available (ADMIN_PASSWORD set). When false, only
   *  the OAuth buttons are shown — no dead password box for an OAuth-only gate. */
  passwordLogin?: boolean;
  initialErrorCode?: string | null;
}

// Maps short error codes from the /oauth/*/callback redirect into readable
// messages. Unknown codes fall through to a generic message so we never
// leak an opaque code to the user.
function oauthErrorMessage(code: string): string {
  switch (code) {
    case "github_org":
      return "Your GitHub account is not a confirmed member of the allowed organization. Ask an admin to install the GitHub App on the org and grant Members: Read, then try again.";
    case "github_userinfo":
      return "Could not read your GitHub profile. Please try again.";
    case "oauth_state":
      return "Your sign-in session expired or was tampered with. Please try again.";
    case "oauth_code":
      return "Sign-in was cancelled before it completed. Please try again.";
    case "oauth_exchange":
      return "GitHub sign-in failed. Please try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

export function Login({ onAuthed, slackOAuth, githubOAuth, passwordLogin = true, initialErrorCode }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    initialErrorCode ? oauthErrorMessage(initialErrorCode) : null,
  );
  const [busy, setBusy] = useState(false);
  const [slackRedirecting, setSlackRedirecting] = useState(false);
  const [githubRedirecting, setGithubRedirecting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await api.login(password);
      auth.setToken(token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message === "401 Unauthorized" ? "invalid password" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSlackLogin = () => {
    setSlackRedirecting(true);
    window.location.href = "/admin/api/oauth/slack/authorize";
  };

  const handleGithubLogin = () => {
    setGithubRedirecting(true);
    window.location.href = "/admin/api/oauth/github/authorize";
  };

  return (
    <div className="h-full flex items-center justify-center bg-base-100">
      <div className="card bg-base-200 border border-base-300 w-80 shadow-sm">
        <div className="card-body gap-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">Last Light</div>
            <div className="text-xs text-base-content/50">Sign in to continue</div>
          </div>

          {error && (
            <div role="alert" className="alert alert-error alert-soft text-xs py-2 px-3">
              <span>{error}</span>
            </div>
          )}

          {slackOAuth && (
            <button
              type="button"
              className="btn btn-outline btn-sm w-full"
              onClick={handleSlackLogin}
              disabled={slackRedirecting}
            >
              {slackRedirecting ? "Redirecting..." : "Login with Slack"}
            </button>
          )}

          {githubOAuth && (
            <button
              type="button"
              className="btn btn-outline btn-sm w-full"
              onClick={handleGithubLogin}
              disabled={githubRedirecting}
            >
              {githubRedirecting ? "Redirecting..." : "Login with GitHub"}
            </button>
          )}

          {passwordLogin && (slackOAuth || githubOAuth) && (
            <div className="divider text-xs text-base-content/40 my-0">or</div>
          )}

          {passwordLogin && (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <input
                type="password"
                autoFocus
                className="input input-bordered input-sm w-full"
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy || !password}
              >
                {busy ? "..." : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
