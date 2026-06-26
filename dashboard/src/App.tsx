import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from "react";
import { api, auth, onUnauthorized, UnauthorizedError } from "./api";
import { StatsHeader } from "./components/StatsHeader";
import { SessionList } from "./components/SessionList";
import { SessionFilters } from "./components/SessionFilters";
import { MessageFeed, type MessageOrder } from "./components/MessageFeed";
import { Login } from "./components/Login";
import { CliAuthorize } from "./components/CliAuthorize";
import { useSessionStream } from "./hooks/useSessionStream";
import { WorkflowList } from "./components/WorkflowList";
import { WorkflowDefinitions } from "./components/WorkflowDefinitions";
import { HomePage } from "./components/HomePage";
import { CronsList } from "./components/CronsList";
import { ConfigPage } from "./components/ConfigPage";
import { UpdateBanner } from "./components/UpdateBanner";
// Lazy — the Artifacts editor pulls in MDXEditor (Lexical + CodeMirror, ~1 MB),
// which would otherwise triple the initial bundle. Code-split so it loads only
// when the Artifacts tab is opened.
const ArtifactsPage = lazy(() =>
  import("./components/ArtifactsPage").then((m) => ({ default: m.ArtifactsPage })),
);
// Lazy for the same reason as ArtifactsPage — the focused approval view embeds
// the MDXEditor in server mode.
const FocusedApprovalView = lazy(() =>
  import("./components/FocusedApprovalView").then((m) => ({ default: m.FocusedApprovalView })),
);
import {
  HomeIcon,
  PlayCircleIcon,
  CubeTransparentIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  RectangleGroupIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import {
  useUrlState,
  enumParser,
  enumSerializer,
  stringParser,
  stringSerializer,
  nullableStringParser,
  nullableStringSerializer,
} from "./hooks/useUrlState";

type AuthState = "checking" | "required" | "ok";
type Tab = "home" | "sessions" | "chat-sessions" | "workflows" | "runs" | "crons" | "config" | "artifacts";

const PAGE_SIZE = 50;

const TABS = ["home", "workflows", "runs", "sessions", "chat-sessions", "artifacts", "crons", "config"] as const;

const SESSION_SOURCE_PATHS: Record<"sessions" | "chat-sessions", string> = {
  sessions: "/admin/api/sessions",
  "chat-sessions": "/admin/api/chat-sessions",
};
const TIME_RANGES = ["hour", "day", "week", "all", "live"] as const;

function Dashboard({ onLogout }: { onLogout: () => void }) {
  // ── Filters & navigation, all persisted to the URL ─────────────────────
  const [tab, setTab] = useUrlState<Tab>(
    "tab",
    "home",
    enumParser(TABS, "home"),
    enumSerializer<Tab>("home"),
  );
  type TimeRange = (typeof TIME_RANGES)[number];
  const [timeRange, setTimeRange] = useUrlState<TimeRange>(
    "range",
    "day",
    enumParser(TIME_RANGES, "day"),
    enumSerializer<TimeRange>("day"),
  );
  const [query, setQuery] = useUrlState<string>(
    "q",
    "",
    stringParser,
    stringSerializer,
  );
  const [sourceFilter, setSourceFilter] = useUrlState<string | null>(
    "source",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [_userSelected, setUserSelected] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const showLiveOnly = timeRange === "live";
  const [order, setOrder] = useState<MessageOrder>(
    () => (localStorage.getItem("ll-order") as MessageOrder) ?? "newest",
  );

  useEffect(() => {
    localStorage.setItem("ll-order", order);
  }, [order]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  // Both Sessions and Chat Sessions tabs share the same UI; only the on-disk
  // source path differs. The hook re-subscribes when sourcePath changes.
  const sessionSourcePath =
    tab === "chat-sessions" ? SESSION_SOURCE_PATHS["chat-sessions"] : SESSION_SOURCE_PATHS.sessions;
  const isChatSessionsTab = tab === "chat-sessions";
  const { sessions, status, error } = useSessionStream(limit, sessionSourcePath);

  // Selected session id is per-source — switching tabs should clear it so we
  // don't try to render a sandbox session id against the chat stream.
  useEffect(() => {
    setSelectedId(null);
    setUserSelected(false);
  }, [sessionSourcePath]);

  const availableSources = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.sessionType || "agent"))).sort(),
    [sessions],
  );
  const sourceCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) {
      const t = s.sessionType || "agent";
      out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    let out = sessions;

    // Time range filter
    if (timeRange === "live") {
      out = out.filter((s) => s.live);
    } else if (timeRange !== "all") {
      const now = Date.now() / 1000;
      const cutoffs: Record<string, number> = { hour: 3600, day: 86400, week: 604800 };
      const cutoff = now - (cutoffs[timeRange] ?? 86400);
      out = out.filter((s) => s.started_at >= cutoff);
    }

    if (sourceFilter) out = out.filter((s) => (s.sessionType || "agent") === sourceFilter);
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      out = out.filter((s) => {
        const fields = [
          s.id,
          s.title ?? "",
          s.last_assistant_content ?? "",
          s.model ?? "",
          s.source,
        ];
        return fields.some((f) => f.toLowerCase().includes(q));
      });
    }
    return out;
  }, [sessions, sourceFilter, debouncedQuery, timeRange]);

  useEffect(() => {
    if (selectedId && !filteredSessions.some((s) => s.id === selectedId)) {
      setSelectedId(filteredSessions.length > 0 ? filteredSessions[0]!.id : null);
      setUserSelected(false);
      return;
    }
    if (!selectedId && filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0]!.id);
    }
  }, [filteredSessions, selectedId]);

  const handleSelect = (id: string) => {
    setUserSelected(true);
    setSelectedId(id);
  };

  const selectedSession = useMemo(
    () => filteredSessions.find((s) => s.id === selectedId),
    [filteredSessions, selectedId],
  );

  // ── Workflow live count (for the header pill on the workflows tab) ─────
  // Polled independently of the WorkflowList's own data load so the count
  // stays accurate even when the user is on the sessions tab.
  const [workflowLiveCount, setWorkflowLiveCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.workflowRuns({ limit: 1, status: "active" });
        if (!cancelled) setWorkflowLiveCount(res.total);
      } catch {
        /* ignore */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sessionLiveCount = useMemo(
    () => sessions.filter((s) => s.live).length,
    [sessions],
  );

  const [containers, setContainers] = useState<Array<{ name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { containers: c } = await api.containers();
        if (!cancelled) setContainers(c);
      } catch {
        /* ignore */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const handleTerminate = useCallback(async () => {
    if (containers.length === 0) return;
    const target = containers[0];
    if (target) {
      await api.killContainer(target.name);
      try {
        const { containers: c } = await api.containers();
        setContainers(c);
      } catch {
        /* ignore */
      }
    }
  }, [containers]);

  // The header's "live" pill shows whichever count is relevant for the active
  // tab — workflow runs vs raw sessions.
  const headerLiveCount = tab === "sessions" ? sessionLiveCount : workflowLiveCount;

  return (
    <div className="flex flex-col h-full">
      <StatsHeader
        timeRange={timeRange}
        onTimeRangeChange={(r) => setTimeRange(r as TimeRange)}
        liveCount={headerLiveCount}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          // Searching from the home page is meaningless — Home has no
          // searchable list. Hop the user to Workflow Runs so the query has
          // somewhere to apply.
          if (tab === "home" && q.length > 0) setTab("runs");
        }}
        streamStatus={status}
        onLogout={onLogout}
      />
      <UpdateBanner />
      <div className="flex flex-1 overflow-hidden">
        <nav className="flex flex-col shrink-0 w-14 border-r border-base-300 bg-base-200/60 py-2 gap-1">
          {(
            [
              { id: "home", label: "Home", Icon: HomeIcon },
              { id: "workflows", label: "Workflows", Icon: RectangleGroupIcon },
              { id: "runs", label: "Workflow Runs", Icon: PlayCircleIcon },
              { id: "sessions", label: "Sandbox Sessions", Icon: CubeTransparentIcon },
              { id: "chat-sessions", label: "Chat Sessions", Icon: ChatBubbleLeftRightIcon },
              { id: "artifacts", label: "Artifacts", Icon: DocumentTextIcon },
              { id: "crons", label: "Crons", Icon: ClockIcon },
              { id: "config", label: "Config", Icon: Cog6ToothIcon },
            ] as const
          ).map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id as Tab)}
                aria-label={label}
                title={label}
                className={`group relative flex items-center justify-center mx-2 h-10 rounded-md border-l-2 transition-colors ${
                  active
                    ? "border-primary text-primary bg-primary/10"
                    : "border-transparent text-base-content/70 hover:text-base-content hover:bg-base-300/50"
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? "" : "opacity-70"}`} />
                <span className="pointer-events-none absolute left-full ml-2 z-20 whitespace-nowrap rounded-md bg-base-300 px-2 py-1 text-xs font-medium text-base-content shadow-lg opacity-0 -translate-x-1 transition-all duration-100 group-hover:opacity-100 group-hover:translate-x-0">
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
      {tab === "home" ? (
        <HomePage
          onSelectWorkflow={(id) => {
            // Pre-write `run` into the URL so WorkflowList picks it up the
            // moment it mounts after the tab switch (its useUrlState reads
            // the URL on first render).
            const url = new URL(window.location.href);
            url.searchParams.set("run", id);
            window.history.replaceState(null, "", url.toString());
            setTab("runs");
          }}
        />
      ) : tab === "sessions" || tab === "chat-sessions" ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <SessionFilters
            availableSources={availableSources}
            sourceCounts={sourceCounts}
            totalCount={sessions.length}
            sourceFilter={sourceFilter}
            onFilterChange={setSourceFilter}
          />
          <div className="flex flex-1 overflow-hidden">
            <SessionList
              sessions={filteredSessions}
              error={error}
              selectedId={selectedId}
              onSelect={handleSelect}
              query={debouncedQuery}
              onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
              totalAvailable={sessions.length}
              showLiveOnly={showLiveOnly}
            />
            <MessageFeed
              sessionId={selectedId}
              sourcePath={sessionSourcePath}
              order={order}
              onOrderChange={setOrder}
              searchQuery={debouncedQuery}
              isLive={selectedSession?.live}
              // Chat sessions are in-process and have no docker container to
              // terminate. Hide the kill button for that tab.
              onTerminate={isChatSessionsTab ? undefined : handleTerminate}
            />
          </div>
        </div>
      ) : tab === "crons" ? (
        <CronsList
          onOpenRuns={(workflow) => {
            // Widen the time window so an old "last run" (a weekly cron may
            // not have fired in days) is actually visible — the runs tab
            // defaults to the last day.
            setTimeRange("all");
            const url = new URL(window.location.href);
            url.searchParams.set("workflow", workflow);
            url.searchParams.set("range", "all");
            url.searchParams.delete("run");
            window.history.replaceState(null, "", url.toString());
            setTab("runs");
          }}
        />
      ) : tab === "workflows" ? (
        <WorkflowDefinitions />
      ) : tab === "artifacts" ? (
        <Suspense fallback={<div className="p-6 text-sm text-base-content/50">Loading editor…</div>}>
          <ArtifactsPage />
        </Suspense>
      ) : tab === "config" ? (
        <ConfigPage />
      ) : (
        <WorkflowList
          timeRange={timeRange}
          query={debouncedQuery}
          onOpenDefinition={(name) => {
            // Switch to the Workflows browser with the named workflow
            // pre-selected. The browser reads `wf` from the URL on mount.
            const url = new URL(window.location.href);
            url.searchParams.set("wf", name);
            url.searchParams.delete("run");
            url.searchParams.delete("phase");
            window.history.replaceState(null, "", url.toString());
            setTab("workflows");
          }}
        />
      )}
        </div>
      </div>
    </div>
  );
}

// ── CLI login handoff ────────────────────────────────────────────────────────
// `lastlight login` opens this dashboard with a loopback `cli_callback` so we
// can hand a token back to the local CLI once the user authenticates. We only
// ever redirect to loopback hosts (127.0.0.1 / localhost / [::1]) so the
// dashboard can't be abused as an open token-exfiltration redirector.
const CLI_LOGIN_KEY = "cli_login";
interface CliLogin { callback: string; state: string; }

function isLoopbackCallback(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") return false;
    const h = u.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function readCliLogin(): CliLogin | null {
  try {
    const raw = sessionStorage.getItem(CLI_LOGIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CliLogin;
    if (parsed.callback && parsed.state && isLoopbackCallback(parsed.callback)) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function readApprovalId(): string | null {
  return new URLSearchParams(window.location.search).get("approval");
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [slackOAuth, setSlackOAuth] = useState(false);
  const [githubOAuth, setGithubOAuth] = useState(false);
  const [passwordLogin, setPasswordLogin] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [cliLogin, setCliLogin] = useState<CliLogin | null>(() => readCliLogin());
  // Focused approval deep link (?approval=<id>). Tracked here so it survives
  // login and re-reads on pushState/popstate navigation.
  const [approvalId, setApprovalId] = useState<string | null>(() => readApprovalId());

  useEffect(() => {
    const onPop = () => setApprovalId(readApprovalId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        // Handle OAuth callback: if ?token= is in URL, store it and strip from history.
        // If ?error= is present (set by the server on OAuth failure), capture it for
        // display on the login card and strip it from the URL.
        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get("token");
        const urlError = params.get("error");
        // CLI login handoff: stash a loopback callback so it survives the
        // OAuth round-trip (which returns to /admin/?token=…, dropping query
        // params we don't persist). Rejected unless the callback is loopback.
        const cliCallback = params.get("cli_callback");
        const cliState = params.get("cli_state");
        let strippedCli = false;
        if (cliCallback && cliState && isLoopbackCallback(cliCallback)) {
          const entry: CliLogin = { callback: cliCallback, state: cliState };
          sessionStorage.setItem(CLI_LOGIN_KEY, JSON.stringify(entry));
          if (!cancelled) setCliLogin(entry);
          params.delete("cli_callback");
          params.delete("cli_state");
          strippedCli = true;
        }
        if (urlToken) {
          auth.setToken(urlToken);
          params.delete("token");
        }
        if (urlError && !cancelled) {
          setLoginError(urlError);
          params.delete("error");
        }
        if (urlToken || urlError || strippedCli) {
          const newSearch = params.toString();
          const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
          window.history.replaceState(null, "", newUrl);
        }

        const { required, password: passwordEnabled, slackOAuth: oauthEnabled, githubOAuth: githubOauthEnabled } = await api.authRequired();
        if (cancelled) return;
        if (!cancelled) setSlackOAuth(oauthEnabled);
        if (!cancelled) setGithubOAuth(githubOauthEnabled);
        if (!cancelled) setPasswordLogin(passwordEnabled);
        if (!required) {
          setAuthState("ok");
          return;
        }
        if (auth.getToken()) {
          try {
            await api.health();
            if (!cancelled) setAuthState("ok");
            return;
          } catch (e) {
            if (e instanceof UnauthorizedError) {
              if (!cancelled) setAuthState("required");
              return;
            }
          }
        }
        if (!cancelled) setAuthState("required");
      } catch {
        if (!cancelled) setAuthState("required");
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  // If a token expires while the dashboard is mounted, any API call returns
  // 401; api.ts clears the token and notifies here so we drop straight to the
  // login screen instead of leaving a stale view until a manual refresh.
  useEffect(() => {
    return onUnauthorized(() => {
      setLoginError(null);
      setAuthState("required");
    });
  }, []);

  if (authState === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-base-content/40">...</div>
    );
  }
  if (authState === "required") {
    return (
      <Login
        onAuthed={() => setAuthState("ok")}
        slackOAuth={slackOAuth}
        githubOAuth={githubOAuth}
        passwordLogin={passwordLogin}
        initialErrorCode={loginError}
      />
    );
  }
  if (cliLogin) {
    return (
      <CliAuthorize
        callback={cliLogin.callback}
        state={cliLogin.state}
        onCancel={() => {
          sessionStorage.removeItem(CLI_LOGIN_KEY);
          setCliLogin(null);
        }}
      />
    );
  }
  if (approvalId) {
    return (
      <Suspense fallback={<div className="h-full flex items-center justify-center text-base-content/40">Loading…</div>}>
        <FocusedApprovalView
          approvalId={approvalId}
          onClose={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete("approval");
            window.history.pushState(null, "", url.toString());
            setApprovalId(null);
          }}
        />
      </Suspense>
    );
  }
  return (
    <Dashboard
      onLogout={() => {
        auth.clear();
        setAuthState("required");
      }}
    />
  );
}
