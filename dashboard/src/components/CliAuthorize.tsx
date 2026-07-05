import { useState } from "react";
import { auth } from "../api";

/**
 * Shown after the user is authenticated when the dashboard was opened by
 * `lastlight login` (a loopback `cli_callback` was present in the URL). It
 * hands the session token back to the local CLI by redirecting the browser to
 * the loopback callback with `?token=&state=`.
 *
 * The callback host is validated as loopback by App.tsx before we ever get
 * here, so we only redirect to 127.0.0.1 / localhost. We still require explicit
 * user consent (Authorize) so a logged-in session can't be silently siphoned.
 */
export function CliAuthorize({
  callback,
  state,
  onCancel,
}: {
  callback: string;
  state: string;
  onCancel: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let host = callback;
  try {
    host = new URL(callback).host;
  } catch {
    /* shown as-is */
  }

  const authorize = async () => {
    setWorking(true);
    setError(null);
    try {
      // ALWAYS mint a fresh token for the CLI rather than recycling whatever is
      // in localStorage — that stored token may be days old and near (or past)
      // expiry, which previously handed the CLI a dead-on-arrival credential.
      // The refresh route is authed, so send the current token when we have one;
      // when auth is disabled it returns an open-access token regardless.
      const existing = auth.getToken();
      const res = await fetch("/admin/api/token/refresh", {
        method: "POST",
        headers: existing ? { Authorization: `Bearer ${existing}` } : {},
      });
      const token = res.ok ? (((await res.json()) as { token?: string }).token ?? null) : null;
      if (!token) {
        setError("Could not mint a fresh token to hand to the CLI.");
        setWorking(false);
        return;
      }
      const url = `${callback}?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="card bg-base-200 shadow-xl w-full max-w-md">
        <div className="card-body">
          <h2 className="card-title">Authorize CLI login</h2>
          <p className="text-sm text-base-content/70">
            A command-line tool on this machine (<code className="text-xs">{host}</code>) is
            requesting access to this Last Light instance. Authorizing sends it a session token
            valid for ~30 days (and the CLI keeps it renewed while you use it).
          </p>
          {error && <div className="alert alert-error text-sm">{error}</div>}
          <div className="card-actions justify-end mt-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={working}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={authorize} disabled={working}>
              {working ? "Authorizing…" : "Authorize"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
