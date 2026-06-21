import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  created: string;
  taskId: string | null;
  image: string;
}

export interface ContainerStats {
  name: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

export async function killContainer(containerName: string): Promise<void> {
  await exec("docker", ["rm", "-f", containerName]);
}

/**
 * Snapshot CPU/memory for every container whose name starts with `lastlight-`
 * (the agent itself plus any active sandboxes). Uses `docker stats --no-stream`
 * so each call is one read of cgroup counters — slower than a metadata lookup
 * but still ~sub-second on a small fleet.
 */
export async function getContainerStats(): Promise<ContainerStats[]> {
  try {
    const { stdout } = await exec("docker", [
      "stats",
      "--no-stream",
      "--format", "{{json .}}",
    ]);
    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((c) => (c.Name ?? "").startsWith("lastlight"))
      .map((c) => {
        const name = c.Name ?? "";
        const cpuPercent = parsePercent(c.CPUPerc);
        const memPercent = parsePercent(c.MemPerc);
        const [usage, limit] = parseMemUsage(c.MemUsage);
        return {
          name,
          cpuPercent,
          memUsageBytes: usage,
          memLimitBytes: limit,
          memPercent,
        };
      });
  } catch {
    return [];
  }
}

function parsePercent(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw.replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

// Docker formats memory like "123.4MiB / 7.7GiB" — convert each side to bytes.
function parseMemUsage(raw: string | undefined): [number, number] {
  if (!raw) return [0, 0];
  const parts = raw.split("/").map((p) => p.trim());
  return [parseSize(parts[0] ?? ""), parseSize(parts[1] ?? "")];
}

function parseSize(raw: string): number {
  const m = raw.match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const value = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  return value * (multipliers[unit] ?? 1);
}

export async function listRunningContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await exec("docker", [
      "ps",
      "--filter", "name=lastlight-sandbox",
      "--format", "{{json .}}",
    ]);

    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split("\n")
      .map((line) => {
        const c = JSON.parse(line) as Record<string, string>;
        const name = c.Names ?? c.Name ?? "";
        // Parse taskId from: lastlight-sandbox-{taskId}-{uuid}
        const match = name.match(/^lastlight-sandbox-(.+?)-[a-f0-9]{8}$/);
        return {
          id: c.ID ?? "",
          name,
          status: c.Status ?? "",
          created: c.CreatedAt ?? c.RunningFor ?? "",
          taskId: match?.[1] ?? null,
          image: c.Image ?? "",
        };
      });
  } catch {
    return [];
  }
}

export interface ServerContainer {
  name: string;
  /** Short label derived from the compose name: lastlight-<service>-<n>. */
  service: string;
  status: string;
  image: string;
}

/**
 * Every `lastlight-*` container (the agent plus the egress sidecars,
 * otel-collector, dozzle, and any live sandboxes) — running or stopped. Used
 * by the server-logs endpoints so an operator can read the harness/docker logs
 * over the admin API instead of SSHing to the host.
 */
export async function listServerContainers(): Promise<ServerContainer[]> {
  try {
    const { stdout } = await exec("docker", [
      "ps", "-a",
      "--filter", "name=lastlight-",
      "--format", "{{json .}}",
    ]);
    if (!stdout.trim()) return [];
    return stdout.trim().split("\n").map((line) => {
      const c = JSON.parse(line) as Record<string, string>;
      const name = c.Names ?? c.Name ?? "";
      return {
        name,
        service: name.replace(/^lastlight-/, "").replace(/-\d+$/, ""),
        status: c.Status ?? "",
        image: c.Image ?? "",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Resolve a requested container (by full name OR short service label) to a real
 * `lastlight-*` container name, validated against the live list. Returns null
 * if nothing matches — callers reject the request, so an arbitrary container
 * name can never reach `docker logs`. With no request, defaults to the agent.
 */
export async function resolveServerContainer(requested?: string): Promise<string | null> {
  const containers = await listServerContainers();
  if (requested) {
    const hit = containers.find((c) => c.name === requested || c.service === requested);
    return hit?.name ?? null;
  }
  const agent = containers.find((c) => c.service === "agent" || c.name.includes("-agent-"));
  return agent?.name ?? containers[0]?.name ?? null;
}

/**
 * One-shot `docker logs` for a container, newest `tail` lines. `--timestamps`
 * lets us interleave the container's stdout and stderr (captured on separate
 * fds) back into chronological order — RFC3339 prefixes sort lexically.
 */
export async function getContainerLogs(
  name: string,
  opts: { tail?: number; since?: string } = {},
): Promise<string[]> {
  const args = ["logs", "--timestamps", "--tail", String(opts.tail ?? 200)];
  if (opts.since) args.push("--since", opts.since);
  args.push(name);
  const { stdout, stderr } = await exec("docker", args, { maxBuffer: 32 * 1024 * 1024 });
  const lines = [
    ...(stdout ? stdout.split("\n") : []),
    ...(stderr ? stderr.split("\n") : []),
  ].filter((l) => l.length > 0);
  lines.sort((a, b) => a.slice(0, 30).localeCompare(b.slice(0, 30)));
  return lines;
}

/**
 * Follow `docker logs -f` for a container, invoking `onLine` per line from both
 * stdout and stderr. Returns a stop function that kills the child process.
 */
export function streamContainerLogs(
  name: string,
  opts: { tail?: number },
  onLine: (line: string) => void,
): () => void {
  const child = spawn("docker", [
    "logs", "-f", "--timestamps", "--tail", String(opts.tail ?? 200), name,
  ]);
  const handle = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line) onLine(line);
  };
  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);
  return () => {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  };
}
