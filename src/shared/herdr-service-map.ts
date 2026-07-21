// Pure HostServiceMap product logic: interest, URL compose, freshness, queue
// priority. No Node, no Electron — unit-tested and shared by main + renderer.
//
// Side-channel probes (LISTEN ports) never live here; this module only decides
// *whether* and *how urgently* to probe, and how to project results for UI.

export type HerdrServiceHealth =
  | "unknown"
  | "pending"
  | "live"
  | "stale"
  | "dead"
  | "skipped";

export type HerdrServicePriority = "intent" | "change" | "ambient";

export interface HerdrServiceProcess {
  readonly name?: string;
  readonly cmdline?: string;
  readonly pid?: number;
}

export interface HerdrServicePort {
  readonly port: number;
  readonly protocol?: "tcp" | "udp";
  readonly address?: string;
}

export interface HerdrServiceProjection {
  readonly hostId: string;
  readonly session?: string | null;
  readonly paneId: string;
  readonly health: HerdrServiceHealth;
  readonly processes?: ReadonlyArray<HerdrServiceProcess>;
  readonly interesting?: boolean;
  readonly ports?: ReadonlyArray<HerdrServicePort>;
  readonly url?: string;
  readonly hostBase?: string;
  /** Tailscale SVC / serve label when url was joined from serve catalog. */
  readonly serveLabel?: string;
  /** True when url came from Tailscale Serve/SVC rather than host:port. */
  readonly serveJoined?: boolean;
  readonly checkedAt?: number;
  readonly error?: string;
  readonly priority?: HerdrServicePriority;
}

export interface HerdrServiceQueueItem {
  readonly hostId: string;
  readonly session?: string | null;
  readonly paneId: string;
  readonly priority: HerdrServicePriority;
  readonly enqueuedAt: number;
  /** Optional seed processes so a probe can skip process-info when fresh. */
  readonly processes?: ReadonlyArray<HerdrServiceProcess>;
}

/** Shell names that never own a listen socket worth projecting. */
const SHELL_NAMES = new Set([
  "zsh",
  "-zsh",
  "bash",
  "-bash",
  "sh",
  "-sh",
  "fish",
  "-fish",
  "dash",
  "nu",
  "pwsh",
  "powershell",
]);

/**
 * Substrings that strongly suggest a long-lived HTTP/dev server in cmdline.
 * Conservative: false positives cost one LISTEN probe; false negatives hide whoa.
 */
const SERVER_HINTS = [
  "vite",
  "next",
  "next-server",
  "webpack-dev-server",
  "webpack",
  "nuxt",
  "astro",
  "remix",
  "express",
  "fastify",
  "hono",
  "nestjs",
  "uvicorn",
  "gunicorn",
  "hypercorn",
  "fastapi",
  "flask",
  "django",
  "rails",
  "puma",
  "sidekiq",
  "bun --hot",
  "bun run dev",
  "bun run start",
  "node .*dev",
  "tsx watch",
  "ts-node-dev",
  "nodemon",
  "effect.*http",
  "http-server",
  "serve -",
  "parcel",
  "esbuild --serve",
  "deno run",
  "wrangler",
  "miniflare",
  "storybook",
  "docusaurus",
] as const;

const processBlob = (p: HerdrServiceProcess): string =>
  `${p.name ?? ""} ${p.cmdline ?? ""}`.toLowerCase();

export const isShellProcess = (p: HerdrServiceProcess): boolean => {
  const name = (p.name ?? "").toLowerCase();
  if (SHELL_NAMES.has(name)) return true;
  const cmd = (p.cmdline ?? "").trim().toLowerCase();
  if (!cmd) return SHELL_NAMES.has(name);
  // bare shell argv
  const first = cmd.split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return SHELL_NAMES.has(base) || SHELL_NAMES.has(`-${base}`);
};

export const processLooksLikeServer = (p: HerdrServiceProcess): boolean => {
  if (isShellProcess(p)) return false;
  const blob = processBlob(p);
  if (!blob.trim()) return false;
  for (const hint of SERVER_HINTS) {
    if (hint.includes(".*")) {
      try {
        if (new RegExp(hint, "i").test(blob)) return true;
      } catch {
        // ignore bad pattern
      }
    } else if (blob.includes(hint)) {
      return true;
    }
  }
  // node/bun/deno with "dev" or "start" token
  if (/\b(node|bun|deno|python|python3|ruby|php)\b/.test(blob) && /\b(dev|start|serve|server)\b/.test(blob)) {
    return true;
  }
  return false;
};

/** True when any foreground process is worth a LISTEN probe. */
export const isInterestingProcessSet = (
  processes: ReadonlyArray<HerdrServiceProcess> | undefined,
): boolean => {
  if (!processes || processes.length === 0) return false;
  return processes.some((p) => processLooksLikeServer(p) || (!isShellProcess(p) && typeof p.pid === "number"));
};

/**
 * Strong interest: clearly a server. Weak interest: non-shell with pid
 * (probe once, then skip ambient if no ports).
 */
export const interestLevel = (
  processes: ReadonlyArray<HerdrServiceProcess> | undefined,
): "none" | "weak" | "strong" => {
  if (!processes || processes.length === 0) return "none";
  if (processes.some(processLooksLikeServer)) return "strong";
  if (processes.some((p) => !isShellProcess(p) && typeof p.pid === "number")) return "weak";
  return "none";
};

/** Stable identity for change detection (not full argv dump). */
export const processIdentityKey = (
  processes: ReadonlyArray<HerdrServiceProcess> | undefined,
): string => {
  if (!processes || processes.length === 0) return "";
  return processes
    .map((p) => `${p.pid ?? ""}|${p.name ?? ""}|${(p.cmdline ?? "").slice(0, 120)}`)
    .sort()
    .join("\n");
};

export const processIdentityChanged = (
  previous: ReadonlyArray<HerdrServiceProcess> | undefined,
  next: ReadonlyArray<HerdrServiceProcess> | undefined,
): boolean => processIdentityKey(previous) !== processIdentityKey(next);

// --- URL compose ------------------------------------------------------------

export interface HostReachability {
  readonly hostId: string;
  readonly kind: "local" | "remote";
  /** SSH endpoint / MagicDNS name when remote (e.g. remote-a). */
  readonly endpoint?: string;
  /** Optional Tailscale IP or MagicDNS override. */
  readonly tailscaleHost?: string;
}

/**
 * Prefer Tailscale override, then SSH endpoint hostname, never invent mesh.
 * Local always 127.0.0.1 (not localhost — avoids v6 surprises).
 */
export const resolveHostBase = (host: HostReachability): string | undefined => {
  if (host.kind === "local" || host.hostId === "local") return "127.0.0.1";
  const ts = host.tailscaleHost?.trim();
  if (ts) return stripUser(ts);
  const endpoint = host.endpoint?.trim();
  if (!endpoint) return undefined;
  return stripUser(endpoint);
};

const stripUser = (endpoint: string): string => {
  // user@host → host; leave bare host / IPv6 as-is
  const at = endpoint.lastIndexOf("@");
  if (at >= 0) return endpoint.slice(at + 1);
  return endpoint;
};

/** Pick the best TCP port for a browser URL (lowest non-privileged preferred for dev). */
export const pickPrimaryPort = (
  ports: ReadonlyArray<HerdrServicePort> | undefined,
): number | undefined => {
  if (!ports || ports.length === 0) return undefined;
  const tcp = ports.filter((p) => (p.protocol ?? "tcp") === "tcp");
  const list = tcp.length > 0 ? tcp : [...ports];
  const sorted = [...list].sort((a, b) => a.port - b.port);
  // Prefer classic dev ports when present
  const preferred = [5173, 3000, 3001, 4173, 8080, 8000, 4000, 5000, 5174];
  for (const p of preferred) {
    if (sorted.some((x) => x.port === p)) return p;
  }
  return sorted[0]?.port;
};

export const composeServiceUrl = (input: {
  readonly hostBase?: string;
  readonly ports?: ReadonlyArray<HerdrServicePort>;
  readonly scheme?: "http" | "https";
}): string | undefined => {
  const base = input.hostBase?.trim();
  if (!base) return undefined;
  const port = pickPrimaryPort(input.ports);
  if (port === undefined) return undefined;
  const scheme = input.scheme ?? "http";
  // IPv6 literal needs brackets
  const host = base.includes(":") && !base.startsWith("[") ? `[${base}]` : base;
  return `${scheme}://${host}:${port}`;
};

// --- Freshness / health -----------------------------------------------------

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_AMBIENT_TTL_MS = 3 * 60_000;

export const deriveHealth = (input: {
  readonly interesting: boolean;
  readonly pending: boolean;
  readonly ports?: ReadonlyArray<HerdrServicePort>;
  readonly checkedAt?: number;
  readonly now?: number;
  readonly staleAfterMs?: number;
  readonly processGone?: boolean;
}): HerdrServiceHealth => {
  if (input.processGone) return "dead";
  if (!input.interesting) return "skipped";
  if (input.pending) return "pending";
  if (input.checkedAt === undefined) return "unknown";
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const hasPort = (input.ports?.length ?? 0) > 0;
  if (!hasPort) return "dead";
  if (now - input.checkedAt > staleAfter) return "stale";
  return "live";
};

export const projectService = (input: {
  readonly hostId: string;
  readonly session?: string | null;
  readonly paneId: string;
  readonly processes?: ReadonlyArray<HerdrServiceProcess>;
  readonly ports?: ReadonlyArray<HerdrServicePort>;
  readonly hostBase?: string;
  /** Prefer Tailscale SVC/serve public URL over host:port compose. */
  readonly urlOverride?: string;
  readonly serveLabel?: string;
  readonly checkedAt?: number;
  readonly pending?: boolean;
  readonly error?: string;
  readonly priority?: HerdrServicePriority;
  readonly now?: number;
  readonly processGone?: boolean;
}): HerdrServiceProjection => {
  const level = interestLevel(input.processes);
  const interesting = level !== "none";
  const health = deriveHealth({
    interesting,
    pending: input.pending === true,
    ports: input.ports,
    checkedAt: input.checkedAt,
    now: input.now,
    processGone: input.processGone,
  });
  const composed =
    health === "live" || health === "stale"
      ? composeServiceUrl({ hostBase: input.hostBase, ports: input.ports })
      : undefined;
  const override =
    (health === "live" || health === "stale") && input.urlOverride?.trim()
      ? input.urlOverride.trim()
      : undefined;
  const url = override ?? composed;
  return {
    hostId: input.hostId,
    session: input.session,
    paneId: input.paneId,
    health,
    processes: input.processes,
    interesting,
    ports: input.ports,
    url,
    hostBase: input.hostBase,
    ...(override
      ? { serveJoined: true as const, serveLabel: input.serveLabel }
      : {}),
    checkedAt: input.checkedAt,
    error: input.error,
    priority: input.priority,
  };
};

// --- Queue -----------------------------------------------------------------

const PRIORITY_RANK: Record<HerdrServicePriority, number> = {
  intent: 0,
  change: 1,
  ambient: 2,
};

/**
 * Merge a new enqueue into an existing queue. Same paneId on same host
 * upgrades priority (intent wins) and refreshes seed processes; no duplicates.
 */
export const enqueueServiceProbe = (
  queue: ReadonlyArray<HerdrServiceQueueItem>,
  item: HerdrServiceQueueItem,
): ReadonlyArray<HerdrServiceQueueItem> => {
  const key = `${item.hostId}\0${item.session ?? ""}\0${item.paneId}`;
  const existing = queue.find(
    (q) => `${q.hostId}\0${q.session ?? ""}\0${q.paneId}` === key,
  );
  if (!existing) {
    return [...queue, item].sort(compareQueueItems);
  }
  const priority =
    PRIORITY_RANK[item.priority] < PRIORITY_RANK[existing.priority]
      ? item.priority
      : existing.priority;
  const merged: HerdrServiceQueueItem = {
    ...existing,
    priority,
    enqueuedAt: Math.min(existing.enqueuedAt, item.enqueuedAt),
    processes: item.processes ?? existing.processes,
  };
  return queue
    .map((q) => (`${q.hostId}\0${q.session ?? ""}\0${q.paneId}` === key ? merged : q))
    .sort(compareQueueItems);
};

export const compareQueueItems = (a: HerdrServiceQueueItem, b: HerdrServiceQueueItem): number => {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pr !== 0) return pr;
  return a.enqueuedAt - b.enqueuedAt;
};

/** Take up to `limit` items for one host (rate-limited worker slice). */
export const takeQueueForHost = (
  queue: ReadonlyArray<HerdrServiceQueueItem>,
  hostId: string,
  limit: number,
): {
  readonly taken: ReadonlyArray<HerdrServiceQueueItem>;
  readonly rest: ReadonlyArray<HerdrServiceQueueItem>;
} => {
  if (limit <= 0) return { taken: [], rest: queue };
  const taken: HerdrServiceQueueItem[] = [];
  const rest: HerdrServiceQueueItem[] = [];
  for (const item of queue) {
    if (item.hostId === hostId && taken.length < limit) {
      taken.push(item);
    } else {
      rest.push(item);
    }
  }
  return { taken, rest };
};

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` style lines into ports for given pids. */
export const parseLsofListen = (
  stdout: string,
  pids: ReadonlyArray<number>,
): ReadonlyArray<HerdrServicePort> => {
  const want = new Set(pids);
  const ports = new Map<number, HerdrServicePort>();
  for (const line of stdout.split("\n")) {
    // Column counts vary across OS builds — require LISTEN + pid + :port.
    if (!line.includes("LISTEN")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid) || !want.has(pid)) continue;
    const m =
      line.match(/:(\d+)\s*\(LISTEN\)/) ||
      line.match(/\*:(\d+)/) ||
      line.match(/\[::\]:(\d+)/) ||
      line.match(/\bTCP\s+\S*:(\d+)/i);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    if (!ports.has(port)) {
      ports.set(port, { port, protocol: "tcp" });
    }
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
};

/**
 * Extract candidate ports from cmdline flags when lsof is empty
 * (bound only to abstract namespace, race, permissions). Best-effort only.
 */
export const portsFromCmdlineHints = (
  processes: ReadonlyArray<HerdrServiceProcess> | undefined,
): ReadonlyArray<HerdrServicePort> => {
  if (!processes) return [];
  const found = new Set<number>();
  for (const p of processes) {
    const cmd = p.cmdline ?? "";
    for (const m of cmd.matchAll(/(?:--port|-p|--port=|-p=)\s*(\d{2,5})\b/gi)) {
      const port = Number(m[1]);
      if (port > 0 && port <= 65535) found.add(port);
    }
    // vite default often implicit — not guessed here
  }
  return [...found].sort((a, b) => a - b).map((port) => ({ port, protocol: "tcp" as const }));
};
