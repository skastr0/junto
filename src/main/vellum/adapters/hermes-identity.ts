import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentIdentity } from "@shared/ipc";
import {
  hermesKeyFor,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import type { CliResult } from "./exec";
import {
  parseAgentKey,
  type HermesHostId,
  type HermesProfileName,
} from "../hermes/domain";
import {
  findHostByHermesId,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";

// Hermes fleet identity, avatar, and messaging adapter. Agent keys are
// "<host>:<profile>" where host is a registry hermes id (local, or a remote
// host's persisted hermesId / id).
//
// SECURITY: only ever reads/forwards displayName, matrixUserId,
// homeRoomName, and hasAvatar. MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_ID,
// MATRIX_HOME_ROOM (the room id, distinct from homeRoomName) and any other
// .env field are extracted via targeted line matching only, never parsed
// into an object, logged, or forwarded across IPC.

export interface HermesIdentityOperations {
  readonly identityBatch: (host: HermesHostId) => Promise<CliResult>;
  readonly avatar: (
    host: HermesHostId,
    profile: HermesProfileName,
  ) => Promise<CliResult>;
}

// ---------------------------------------------------------------------------
// Local filesystem reads
// ---------------------------------------------------------------------------

const LOCAL_HERMES_ROOT = join(homedir(), ".hermes");

const localProfileDir = (profile: string): string =>
  profile === "default" ? LOCAL_HERMES_ROOT : join(LOCAL_HERMES_ROOT, "profiles", profile);

const DISPLAY_NAME_RE = /Display name\/code:\s*(.+)/;

export const readDisplayNameFromContent = (content: string): string | undefined => {
  const value = content.match(DISPLAY_NAME_RE)?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
};

// identity-brief.md lives at <dir>/assets/identity-brief.md on some profiles
// and directly at <dir>/identity-brief.md on others — try both, first match.
const readDisplayName = (dir: string): string | undefined => {
  for (const candidate of [join(dir, "assets", "identity-brief.md"), join(dir, "identity-brief.md")]) {
    if (!existsSync(candidate)) continue;
    try {
      const found = readDisplayNameFromContent(readFileSync(candidate, "utf8"));
      if (found) return found;
    } catch {
      // unreadable — try the next candidate
    }
  }
  return undefined;
};

// Targeted line matching, not whole-file env parsing — see module doc.
export const readEnvFieldFromContent = (content: string, key: string): string | undefined => {
  for (const line of content.split("\n")) {
    if (!line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

const readEnvFields = (dir: string): { matrixUserId?: string; homeRoomName?: string } => {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return {};
  try {
    const content = readFileSync(envPath, "utf8");
    return {
      matrixUserId: readEnvFieldFromContent(content, "MATRIX_USER_ID"),
      homeRoomName: readEnvFieldFromContent(content, "MATRIX_HOME_ROOM_NAME"),
    };
  } catch {
    return {};
  }
};

const hasLocalAvatar = (dir: string): boolean => existsSync(join(dir, "assets", "profile-picture.png"));

const buildLocalIdentity = (
  selfHost: HermesHostId,
  profile: string,
): AgentIdentity => {
  const dir = localProfileDir(profile);
  const env = readEnvFields(dir);
  return {
    key: `${selfHost}:${profile}`,
    displayName: readDisplayName(dir),
    matrixUserId: env.matrixUserId,
    homeRoomName: env.homeRoomName,
    hasAvatar: hasLocalAvatar(dir),
  };
};

const fetchLocalIdentityBatch = async (
  selfHost: HermesHostId,
): Promise<Map<string, AgentIdentity>> => {
  const identities = new Map<string, AgentIdentity>();
  identities.set("default", buildLocalIdentity(selfHost, "default"));
  const profilesDir = join(LOCAL_HERMES_ROOT, "profiles");
  if (existsSync(profilesDir)) {
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        identities.set(entry.name, buildLocalIdentity(selfHost, entry.name));
      }
    } catch {
      // profiles dir unreadable — default profile identity still stands
    }
  }
  return identities;
};

// One tab-separated line -> one profile's identity fields. Exported for unit
// testing; in production this only ever receives the fixed script's stdout.
export const parseIdentityBatchLine = (
  line: string,
): { profile: string; identity: Omit<AgentIdentity, "key"> } | undefined => {
  const parts = line.split("\t");
  if (parts.length < 5) return undefined;
  const [profile, displayName, matrixUserId, homeRoomName, hasAvatarRaw] = parts;
  if (!profile) return undefined;
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    profile,
    identity: {
      displayName: clean(displayName),
      matrixUserId: clean(matrixUserId),
      homeRoomName: clean(homeRoomName),
      hasAvatar: hasAvatarRaw?.trim() === "true",
    },
  };
};

export const parseIdentityBatchOutput = (
  stdout: string,
  hostKey: string,
): Map<string, AgentIdentity> => {
  const identities = new Map<string, AgentIdentity>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const parsed = parseIdentityBatchLine(line);
    if (!parsed) continue;
    identities.set(parsed.profile, {
      key: `${hostKey}:${parsed.profile}`,
      ...parsed.identity,
    });
  }
  return identities;
};

// undefined signals "the ssh call itself failed" — distinct from a Map, even
// an empty one, which means "the ssh call succeeded and the host reported
// zero profiles". fetchHostBatch below relies on that distinction to avoid
// caching a transient failure as a legitimate empty result.
const fetchRemoteIdentityBatch = async (
  operations: HermesIdentityOperations,
  host: HermesHostId,
): Promise<Map<string, AgentIdentity> | undefined> => {
  const result = await operations.identityBatch(host);
  if (!result.ok) return undefined;
  return parseIdentityBatchOutput(result.stdout, host);
};

// ---------------------------------------------------------------------------
// In-memory cache: one batch fetch per host populates every profile's entry.
// A miss (stale TTL or first call) refetches the whole host, never a single
// profile — that is what keeps this to "ONE ssh call for all profiles".
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000;
const AVATAR_CACHE_DIR = join(homedir(), ".vellum", "cache", "avatars");
// Disk entries accelerate repeat reads within one app process only. A fresh
// namespace on restart prevents an undeletable pre-removal avatar from ever
// becoming authoritative when the same route is later re-added.
const AVATAR_PROCESS_NAMESPACE = randomUUID();
const SELF_AUTHORITY = "station-self";

// A failed fetch (ssh down, tailnet blip) must never be cached as if it were
// a legitimate empty result — that poisons every profile on the host for the
// full CACHE_TTL_MS. On failure: if a previous (even TTL-expired) entry
// exists, leave it untouched so the current call still serves that stale-but-
// real data, and the next call retries against the real TTL boundary. With
// nothing to fall back on, record a short-lived failure sentinel so the next
// call retries soon instead of waiting out the full 10 minutes.
const FAILURE_RETRY_MS = 30 * 1000;

interface HostCacheEntry {
  readonly fetchedAt: number;
  readonly authority: string;
  readonly identities: Map<string, AgentIdentity>;
}

interface HostFetchEntry {
  readonly authority: string;
  readonly generation: number;
  readonly promise: Promise<Map<string, AgentIdentity>>;
}

const hostCache = new Map<HermesHostId, HostCacheEntry>();
const hostFetchInFlight = new Map<HermesHostId, HostFetchEntry>();
const hostGenerations = new Map<HermesHostId, number>();

const remoteAuthoritySignature = (host: RemoteHost): string | undefined => {
  if (
    host.kind !== "remote" ||
    !host.sshEndpoint ||
    !hostHasCapability(host, "hermes")
  ) {
    return undefined;
  }
  return JSON.stringify({
    id: host.id,
    hermesId: hermesKeyFor(host),
    endpoint: host.sshEndpoint,
  });
};

/**
 * Resolve the exact current routing authority for a Hermes agent-key host.
 * The station's explicitly supplied self identity is filesystem-owned and
 * independent of the remote-host registry. There is no globally special
 * `local` alias. Every remote read must pass this boundary before touching
 * either memory or disk cache state.
 */
const currentHostAuthority = (
  host: HermesHostId,
  selfHost: HermesHostId,
): string | undefined => {
  if (host === selfHost) return SELF_AUTHORITY;
  const registered = findHostByHermesId(host);
  if (!registered || hermesKeyFor(registered) !== host) return undefined;
  return remoteAuthoritySignature(registered);
};

const generationFor = (host: HermesHostId): number => hostGenerations.get(host) ?? 0;

const avatarHostCacheDir = (host: HermesHostId): string =>
  join(AVATAR_CACHE_DIR, Buffer.from(host, "utf8").toString("base64url"));

/**
 * Clear every cache surface owned by one canonical Hermes host key.
 * Incrementing the generation also revokes results already in flight: those
 * promises may finish at the transport layer, but cannot populate a cache or
 * return their old-endpoint value to the original caller.
 */
export const invalidateHermesIdentityHost = (host: HermesHostId): void => {
  hostGenerations.set(host, generationFor(host) + 1);
  hostCache.delete(host);
  hostFetchInFlight.delete(host);
  try {
    rmSync(avatarHostCacheDir(host), { recursive: true, force: true });
  } catch {
    // Disk cache invalidation is best-effort; generation still revokes reads.
  }
};

const remoteAuthorities = (
  hosts: ReadonlyArray<RemoteHost>,
): Map<HermesHostId, string> => {
  const authorities = new Map<HermesHostId, string>();
  for (const host of hosts) {
    const authority = remoteAuthoritySignature(host);
    if (authority !== undefined) authorities.set(hermesKeyFor(host), authority);
  }
  return authorities;
};

// Host settings are a live routing authority. Invalidate both sides of any
// canonical-key or endpoint change synchronously with the snapshot publish,
// before another renderer request can observe an old cache entry.
subscribeHostsSnapshot((hosts, previous) => {
  const before = remoteAuthorities(previous);
  const after = remoteAuthorities(hosts);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) invalidateHermesIdentityHost(key);
  }
});

const fetchHostBatch = (
  operations: HermesIdentityOperations,
  host: HermesHostId,
  selfHost: HermesHostId,
  authority: string,
): Promise<Map<string, AgentIdentity>> => {
  const inFlight = hostFetchInFlight.get(host);
  const generation = generationFor(host);
  if (
    inFlight &&
    inFlight.authority === authority &&
    inFlight.generation === generation
  ) {
    return inFlight.promise;
  }

  const run = host === selfHost
    ? () => fetchLocalIdentityBatch(selfHost)
    : () => fetchRemoteIdentityBatch(operations, host);
  const promise = run()
    .then((identities) => {
      if (
        generationFor(host) !== generation ||
        currentHostAuthority(host, selfHost) !== authority
      ) {
        return new Map<string, AgentIdentity>();
      }
      if (identities === undefined) {
        const previous = hostCache.get(host);
        if (!previous || previous.authority !== authority) {
          hostCache.set(host, {
            fetchedAt: Date.now() - CACHE_TTL_MS + FAILURE_RETRY_MS,
            authority,
            identities: new Map(),
          });
          return new Map<string, AgentIdentity>();
        }
        return previous.identities;
      }
      hostCache.set(host, { fetchedAt: Date.now(), authority, identities });
      return identities;
    })
    .finally(() => {
      if (hostFetchInFlight.get(host)?.promise === promise) {
        hostFetchInFlight.delete(host);
      }
    });
  hostFetchInFlight.set(host, { authority, generation, promise });
  return promise;
};

export const fetchAgentIdentity = async (
  operations: HermesIdentityOperations,
  key: string,
  selfHost: HermesHostId,
): Promise<AgentIdentity | null> => {
  const parsed = parseAgentKey(key);
  if (!parsed) return null;

  const authority = currentHostAuthority(parsed.host, selfHost);
  if (authority === undefined) {
    invalidateHermesIdentityHost(parsed.host);
    return null;
  }

  const cached = hostCache.get(parsed.host);
  if (
    cached &&
    cached.authority === authority &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached.identities.get(parsed.profile) ?? null;
  }
  if (cached && cached.authority !== authority) {
    invalidateHermesIdentityHost(parsed.host);
  }

  const identities = await fetchHostBatch(
    operations,
    parsed.host,
    selfHost,
    authority,
  );
  if (currentHostAuthority(parsed.host, selfHost) !== authority) return null;
  return identities.get(parsed.profile) ?? null;
};

// ---------------------------------------------------------------------------
// Avatar: data URI, disk-cached under ~/.vellum/cache/avatars/. Capped at
// 4MB decoded; oversized, missing, or unreadable -> null (never throws).
// ---------------------------------------------------------------------------

const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

const authorityCacheKey = (authority: string): string =>
  createHash("sha256").update(authority).digest("hex").slice(0, 16);

const avatarDiskPath = (
  host: HermesHostId,
  profile: string,
  authority: string,
  generation: number,
): string =>
  join(
    avatarHostCacheDir(host),
    `${encodeURIComponent(profile)}-${authorityCacheKey(authority)}-${AVATAR_PROCESS_NAMESPACE}-g${generation}.png`,
  );

const toDataUri = (buf: Buffer): string => `data:image/png;base64,${buf.toString("base64")}`;

const readLocalAvatarBuffer = (profile: string): Buffer | undefined => {
  const path = join(localProfileDir(profile), "assets", "profile-picture.png");
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};

const fetchRemoteAvatarBuffer = async (
  operations: HermesIdentityOperations,
  host: HermesHostId,
  profile: HermesProfileName,
): Promise<Buffer | undefined> => {
  const result = await operations.avatar(host, profile);
  if (!result.ok) return undefined;
  try {
    const buf = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
};

export const fetchAgentAvatar = async (
  operations: HermesIdentityOperations,
  key: string,
  selfHost: HermesHostId,
): Promise<string | null> => {
  const parsed = parseAgentKey(key);
  if (!parsed) return null;

  const authority = currentHostAuthority(parsed.host, selfHost);
  if (authority === undefined) {
    invalidateHermesIdentityHost(parsed.host);
    return null;
  }
  const generation = generationFor(parsed.host);
  const diskPath = avatarDiskPath(
    parsed.host,
    parsed.profile,
    authority,
    generation,
  );
  if (existsSync(diskPath)) {
    try {
      const ageMs = Date.now() - statSync(diskPath).mtimeMs;
      const cached = readFileSync(diskPath);
      if (
        // Filesystems can timestamp a just-written file fractionally ahead of
        // Date.now()'s millisecond clock. Accept only that bounded skew; a
        // materially future-dated file still misses the cache.
        ageMs >= -1_000 &&
        ageMs < CACHE_TTL_MS &&
        cached.length <= MAX_AVATAR_BYTES
      ) {
        return toDataUri(cached);
      }
    } catch {
      // fall through to refetch
    }
  }

  const buf =
    parsed.host === selfHost
      ? readLocalAvatarBuffer(parsed.profile)
      : await fetchRemoteAvatarBuffer(operations, parsed.host, parsed.profile);
  if (
    generationFor(parsed.host) !== generation ||
    currentHostAuthority(parsed.host, selfHost) !== authority
  ) {
    return null;
  }
  if (!buf || buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null;

  try {
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, buf);
  } catch {
    // disk cache is best-effort only
  }

  return toDataUri(buf);
};
