// Pure Tailscale Serve / SVC catalog parse + local-port join.
// Source: `tailscale serve status --json` on the serving host.
// No Node — unit-tested; main process fetches via host shell/SSH.

export type TailscaleServeEntryKind = "svc" | "web" | "tcp-forward";

export interface TailscaleServeEntry {
  readonly kind: TailscaleServeEntryKind;
  /** e.g. svc:control, machine-web, tcp:8090 */
  readonly id: string;
  readonly label: string;
  /**
   * Best browser/open URL for this entry.
   * HTTPS for web/svc, or http(s)://host:publicPort for TCP forwards when host known.
   */
  readonly publicUrl?: string;
  /** Public hostname (MagicDNS) without port. */
  readonly publicHost?: string;
  /** Public port when not 443/80. */
  readonly publicPort?: number;
  readonly path?: string;
  /** Local backend port (from Proxy or TCPForward). */
  readonly localPort?: number;
  readonly localProxy?: string;
  readonly https?: boolean;
}

export interface TailscaleServeCatalog {
  readonly hostId: string;
  readonly entries: ReadonlyArray<TailscaleServeEntry>;
  readonly fetchedAt?: number;
  readonly error?: string;
}

const stripTrailingDot = (s: string): string => s.replace(/\.+$/, "");

const parseHostPort = (
  hostPort: string,
): { readonly host: string; readonly port?: number } => {
  const raw = stripTrailingDot(hostPort.trim());
  // host:443 or [ipv6]:443
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) {
      const host = raw.slice(1, end);
      const rest = raw.slice(end + 1);
      const m = rest.match(/^:(\d+)$/);
      return { host, port: m ? Number(m[1]) : undefined };
    }
  }
  const idx = raw.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) };
  }
  return { host: raw };
};

const localPortFromProxy = (proxy: string | undefined): number | undefined => {
  if (!proxy) return undefined;
  // http://127.0.0.1:5175  http://localhost:3213/foo  https://...
  const m = proxy.match(/:(\d{2,5})(?:\/|$)/);
  if (!m) return undefined;
  const p = Number(m[1]);
  return p > 0 && p <= 65535 ? p : undefined;
};

const localPortFromForward = (forward: string | undefined): number | undefined => {
  if (!forward) return undefined;
  // 127.0.0.1:5175
  const m = forward.match(/:(\d{2,5})\s*$/);
  if (!m) return undefined;
  const p = Number(m[1]);
  return p > 0 && p <= 65535 ? p : undefined;
};

const httpsUrl = (host: string, port: number | undefined, path = "/"): string => {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (port && port !== 443) return `https://${host}:${port}${p === "/" ? "" : p}`;
  return `https://${host}${p === "/" ? "" : p}`;
};

const httpUrl = (host: string, port: number, path = "/"): string => {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://${host}:${port}${p === "/" ? "" : p}`;
};

type HandlerMap = Record<string, { Proxy?: string } | undefined>;

const readHandlers = (webHostCfg: unknown): HandlerMap => {
  if (!webHostCfg || typeof webHostCfg !== "object") return {};
  const handlers = (webHostCfg as Record<string, unknown>).Handlers;
  if (!handlers || typeof handlers !== "object") return {};
  return handlers as HandlerMap;
};

/**
 * Parse `tailscale serve status --json`.
 * @param hostBase Optional MagicDNS/IP of the machine for TCP-forward public URLs.
 */
export const parseTailscaleServeStatus = (
  raw: unknown,
  opts?: { readonly hostId?: string; readonly hostBase?: string },
): TailscaleServeCatalog => {
  const hostId = opts?.hostId ?? "unknown";
  const hostBase = opts?.hostBase?.trim();
  if (!raw || typeof raw !== "object") {
    return { hostId, entries: [] };
  }
  const root = raw as Record<string, unknown>;
  const entries: TailscaleServeEntry[] = [];

  // --- Services (svc:name) -------------------------------------------------
  const services = root.Services;
  if (services && typeof services === "object") {
    for (const [svcName, svcCfg] of Object.entries(services as Record<string, unknown>)) {
      if (!svcCfg || typeof svcCfg !== "object") continue;
      const cfg = svcCfg as Record<string, unknown>;
      const web = cfg.Web;
      if (web && typeof web === "object") {
        for (const [hostPort, webCfg] of Object.entries(web as Record<string, unknown>)) {
          const { host, port } = parseHostPort(hostPort);
          const handlers = readHandlers(webCfg);
          const paths = Object.keys(handlers).sort((a, b) => {
            if (a === "/") return -1;
            if (b === "/") return 1;
            return a.localeCompare(b);
          });
          for (const path of paths.length ? paths : ["/"]) {
            const proxy = handlers[path]?.Proxy;
            const localPort = localPortFromProxy(proxy);
            const label = svcName.replace(/^svc:/, "");
            entries.push({
              kind: "svc",
              id: `${svcName}${path === "/" ? "" : path}`,
              label: path === "/" ? label : `${label}${path}`,
              publicUrl: httpsUrl(host, port, path),
              publicHost: host,
              publicPort: port && port !== 443 ? port : undefined,
              path,
              localPort,
              localProxy: proxy,
              https: true,
            });
          }
        }
      }
    }
  }

  // --- Machine-level Web ---------------------------------------------------
  const webRoot = root.Web;
  if (webRoot && typeof webRoot === "object") {
    for (const [hostPort, webCfg] of Object.entries(webRoot as Record<string, unknown>)) {
      const { host, port } = parseHostPort(hostPort);
      const handlers = readHandlers(webCfg);
      for (const [path, handler] of Object.entries(handlers)) {
        const proxy = handler?.Proxy;
        entries.push({
          kind: "web",
          id: `web:${host}${path}`,
          label: path === "/" ? host.split(".")[0] ?? host : `${host}${path}`,
          publicUrl: httpsUrl(host, port, path),
          publicHost: host,
          publicPort: port && port !== 443 ? port : undefined,
          path,
          localPort: localPortFromProxy(proxy),
          localProxy: proxy,
          https: true,
        });
      }
    }
  }

  // --- Machine TCP forwards ------------------------------------------------
  const tcp = root.TCP;
  if (tcp && typeof tcp === "object") {
    for (const [portStr, tcpCfg] of Object.entries(tcp as Record<string, unknown>)) {
      if (!tcpCfg || typeof tcpCfg !== "object") continue;
      const cfg = tcpCfg as Record<string, unknown>;
      const forward = typeof cfg.TCPForward === "string" ? cfg.TCPForward : undefined;
      if (!forward) continue;
      const publicPort = Number(portStr);
      if (!Number.isFinite(publicPort)) continue;
      const localPort = localPortFromForward(forward);
      const publicUrl = hostBase
        ? httpUrl(hostBase, publicPort)
        : undefined;
      entries.push({
        kind: "tcp-forward",
        id: `tcp:${publicPort}`,
        label: `:${publicPort}→:${localPort ?? "?"}`,
        publicUrl,
        publicHost: hostBase,
        publicPort,
        localPort,
        localProxy: forward,
        https: false,
      });
    }
  }

  return { hostId, entries };
};

/**
 * Prefer public open URL for a set of local LISTEN ports.
 * Order: svc https /  > svc path > machine web > tcp-forward > undefined
 */
export const preferredPublicUrlForLocalPorts = (
  catalog: TailscaleServeCatalog | undefined,
  localPorts: ReadonlyArray<number>,
): {
  readonly url: string;
  readonly entry: TailscaleServeEntry;
} | undefined => {
  if (!catalog || localPorts.length === 0) return undefined;
  const want = new Set(localPorts);
  const hits = catalog.entries.filter(
    (e) => e.localPort !== undefined && want.has(e.localPort) && e.publicUrl,
  );
  if (hits.length === 0) return undefined;

  const rank = (e: TailscaleServeEntry): number => {
    let r = 0;
    if (e.kind === "svc") r += 100;
    else if (e.kind === "web") r += 50;
    else if (e.kind === "tcp-forward") r += 20;
    if (e.https) r += 10;
    if (e.path === "/" || !e.path) r += 5;
    return r;
  };

  hits.sort((a, b) => rank(b) - rank(a));
  const best = hits[0]!;
  return { url: best.publicUrl!, entry: best };
};

/** List only named SVCs (one row per svc name, root path preferred). */
export const listNamedServices = (
  catalog: TailscaleServeCatalog,
): ReadonlyArray<TailscaleServeEntry> => {
  const bySvc = new Map<string, TailscaleServeEntry>();
  for (const e of catalog.entries) {
    if (e.kind !== "svc") continue;
    const name = e.id.replace(/\/.*$/, "");
    const prev = bySvc.get(name);
    if (!prev || e.path === "/" || (prev.path !== "/" && (e.path?.length ?? 99) < (prev.path?.length ?? 99))) {
      bySvc.set(name, e);
    }
  }
  return [...bySvc.values()].sort((a, b) => a.label.localeCompare(b.label));
};
