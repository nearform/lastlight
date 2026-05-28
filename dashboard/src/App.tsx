import { useCallback, useEffect, useMemo, useState } from "react";
import { api, auth, UnauthorizedError } from "./api";
import { StatsHeader } from "./components/StatsHeader";
import { SessionList } from "./components/SessionList";
import { SessionFilters } from "./components/SessionFilters";
import { MessageFeed, type MessageOrder } from "./components/MessageFeed";
import { Login } from "./components/Login";
import { useSessionStream } from "./hooks/useSessionStream";
import { WorkflowList } from "./components/WorkflowList";
import { WorkflowDefinitions } from "./components/WorkflowDefinitions";
import { HomePage } from "./components/HomePage";
import { CronsList } from "./components/CronsList";
import { ConfigPage } from "./components/ConfigPage";
import {
  HomeIcon,
  RectangleStackIcon,
  CubeTransparentIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  Squares2X2Icon,
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
type Tab = "home" | "sessions" | "chat-sessions" | "workflows" | "runs" | "crons" | "config";

const PAGE_SIZE = 50;

const TABS = ["home", "workflows", "runs", "sessions", "chat-sessions", "crons", "config"] as const;

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
      <div className="flex border-b border-base-300 bg-base-200/60 px-3 gap-1">
        {(
          [
            { id: "home", label: "Home", Icon: HomeIcon },
            { id: "workflows", label: "Workflows", Icon: Squares2X2Icon },
            { id: "runs", label: "Workflow Runs", Icon: RectangleStackIcon },
            { id: "sessions", label: "Sandbox Sessions", Icon: CubeTransparentIcon },
            { id: "chat-sessions", label: "Chat Sessions", Icon: ChatBubbleLeftRightIcon },
            { id: "crons", label: "Crons", Icon: ClockIcon },
            { id: "config", label: "Config", Icon: Cog6ToothIcon },
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id as Tab)}
              className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                active
                  ? "border-primary text-primary bg-primary/10"
                  : "border-transparent text-base-content/70 hover:text-base-content hover:bg-base-300/50"
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? "" : "opacity-70"}`} />
              <span className={active ? "font-semibold" : ""}>{label}</span>
            </button>
          );
        })}
      </div>
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
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [slackOAuth, setSlackOAuth] = useState(false);
  const [githubOAuth, setGithubOAuth] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

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
        if (urlToken) {
          auth.setToken(urlToken);
          params.delete("token");
        }
        if (urlError && !cancelled) {
          setLoginError(urlError);
          params.delete("error");
        }
        if (urlToken || urlError) {
          const newSearch = params.toString();
          const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
          window.history.replaceState(null, "", newUrl);
        }

        const { required, slackOAuth: oauthEnabled, githubOAuth: githubOauthEnabled } = await api.authRequired();
        if (cancelled) return;
        if (!cancelled) setSlackOAuth(oauthEnabled);
        if (!cancelled) setGithubOAuth(githubOauthEnabled);
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
        initialErrorCode={loginError}
      />
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
