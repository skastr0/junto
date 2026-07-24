// Pure Tailscale status parsing + peer match for HostServiceMap URL bases.
// No Node — unit-tested; main process supplies status JSON via CLI.

export interface TailscalePeer {
  readonly hostName?: string;
  readonly dnsName?: string;
  /** Preferred IPv4 mesh address when present. */
  readonly ipv4?: string;
  readonly online?: boolean;
  /** Device OS as reported by tailscale ("iOS", "macOS", "linux", …). */
  readonly os?: string;
}

export interface TailscaleStatusSnapshot {
  readonly self?: TailscalePeer;
  readonly peers: ReadonlyArray<TailscalePeer>;
}

export interface TailscaleMatchQuery {
  readonly hostId: string;
  /** SSH endpoint (alias or user@host). */
  readonly endpoint?: string;
}

const stripTrailingDot = (s: string): string => s.replace(/\.+$/, "");

const firstDnsLabel = (dnsName: string): string => {
  const clean = stripTrailingDot(dnsName.trim().toLowerCase());
  return clean.split(".")[0] ?? clean;
};

const normalizeToken = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Extract host token from SSH endpoint (user@host → host). */
export const endpointHostToken = (endpoint: string | undefined): string | undefined => {
  if (!endpoint?.trim()) return undefined;
  const raw = endpoint.trim();
  const at = raw.lastIndexOf("@");
  const host = at >= 0 ? raw.slice(at + 1) : raw;
  // drop brackets for IPv6 literals
  return host.replace(/^\[|\]$/g, "") || undefined;
};

const peerIpv4 = (ips: unknown): string | undefined => {
  if (!Array.isArray(ips)) return undefined;
  for (const ip of ips) {
    if (typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return undefined;
};

const asPeer = (row: unknown): TailscalePeer | undefined => {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const hostName = typeof r.HostName === "string" ? r.HostName : undefined;
  const dnsName = typeof r.DNSName === "string" ? r.DNSName : undefined;
  const ipv4 = peerIpv4(r.TailscaleIPs);
  const online = typeof r.Online === "boolean" ? r.Online : undefined;
  const os = typeof r.OS === "string" && r.OS.trim() ? r.OS.trim() : undefined;
  if (!hostName && !dnsName && !ipv4) return undefined;
  return { hostName, dnsName, ipv4, online, ...(os ? { os } : {}) };
};

/**
 * Parse `tailscale status --json` body into peers + self.
 * Tolerates missing Peer map / alternate shapes.
 */
export const parseTailscaleStatusJson = (raw: unknown): TailscaleStatusSnapshot => {
  if (!raw || typeof raw !== "object") return { peers: [] };
  const root = raw as Record<string, unknown>;
  const self = asPeer(root.Self);
  const peers: TailscalePeer[] = [];
  const peerMap = root.Peer;
  if (peerMap && typeof peerMap === "object") {
    for (const value of Object.values(peerMap as Record<string, unknown>)) {
      const p = asPeer(value);
      if (p) peers.push(p);
    }
  } else if (Array.isArray(root.Peers)) {
    for (const value of root.Peers) {
      const p = asPeer(value);
      if (p) peers.push(p);
    }
  }
  return { self, peers };
};

/** Prefer MagicDNS (no trailing dot), else IPv4. Never invent. */
export const peerReachableHost = (peer: TailscalePeer): string | undefined => {
  if (peer.dnsName?.trim()) return stripTrailingDot(peer.dnsName.trim());
  if (peer.ipv4?.trim()) return peer.ipv4.trim();
  return undefined;
};

const candidateTokens = (query: TailscaleMatchQuery): ReadonlyArray<string> => {
  const tokens = new Set<string>();
  const id = query.hostId.trim().toLowerCase();
  if (id && id !== "local") tokens.add(id);
  const ep = endpointHostToken(query.endpoint);
  if (ep) {
    tokens.add(ep.toLowerCase());
    tokens.add(firstDnsLabel(ep));
  }
  // normalized forms for "mac-mini" vs "Mac mini"
  for (const t of [...tokens]) {
    const n = normalizeToken(t);
    if (n) tokens.add(n);
  }
  return [...tokens].filter(Boolean);
};

const peerScore = (peer: TailscalePeer, tokens: ReadonlyArray<string>): number => {
  let score = 0;
  const dns = peer.dnsName ? stripTrailingDot(peer.dnsName).toLowerCase() : "";
  const dnsLabel = peer.dnsName ? firstDnsLabel(peer.dnsName) : "";
  const hostNorm = peer.hostName ? normalizeToken(peer.hostName) : "";
  const hostRaw = peer.hostName?.toLowerCase() ?? "";

  for (const token of tokens) {
    if (!token) continue;
    if (dnsLabel === token) score = Math.max(score, 100);
    if (dns === token || dns.startsWith(`${token}.`)) score = Math.max(score, 95);
    // Never score against empty hostNorm — `"".includes` is true for every token in JS.
    if (hostNorm.length > 0) {
      if (hostNorm === token || hostNorm === normalizeToken(token)) score = Math.max(score, 80);
      // Substring host match only for tokens long enough to avoid `mac` → Mac mini.
      if (token.length >= 4 && (hostRaw.includes(token) || hostNorm.includes(token))) {
        score = Math.max(score, 55);
      }
    }
  }
  if (peer.online === true) score += 5;
  if (peer.online === false) score -= 20;
  return score;
};

/**
 * Pick the best Tailscale peer for a Vellum host id / SSH endpoint.
 * Returns MagicDNS or IPv4 for URL composition; undefined if no confident match.
 */
export const matchTailscalePeer = (
  query: TailscaleMatchQuery,
  status: TailscaleStatusSnapshot,
  opts?: { readonly minScore?: number },
): TailscalePeer | undefined => {
  if (query.hostId === "local") return undefined;
  const tokens = candidateTokens(query);
  if (tokens.length === 0) return undefined;
  const minScore = opts?.minScore ?? 50;
  const pool = [...status.peers];
  // Self is rarely the remote target; only consider if tokens match strongly
  // (e.g. host id equals this machine's MagicDNS label — unusual for remote).
  if (status.self) pool.push(status.self);

  let best: TailscalePeer | undefined;
  let bestScore = 0;
  for (const peer of pool) {
    const s = peerScore(peer, tokens);
    if (s > bestScore) {
      bestScore = s;
      best = peer;
    }
  }
  if (!best || bestScore < minScore) return undefined;
  return best;
};

export const resolveTailscaleHostForQuery = (
  query: TailscaleMatchQuery,
  status: TailscaleStatusSnapshot,
): string | undefined => {
  const peer = matchTailscalePeer(query, status);
  return peer ? peerReachableHost(peer) : undefined;
};
