import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentIdentity, AgentReply } from "@shared/ipc";
import { runCli } from "./exec";

// Hermes fleet identity, avatar, and messaging adapter. Agent keys are
// "<host>:<profile>", host in {local, remote-a} — matching the key shape
// already used by adapters/hermes.ts's snapshot entities.
//
// SECURITY: only ever reads/forwards displayName, matrixUserId,
// homeRoomName, and hasAvatar. MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_ID,
// MATRIX_HOME_ROOM (the room id, distinct from homeRoomName) and any other
// .env field are extracted via targeted line matching only, never parsed
// into an object, logged, or forwarded across IPC.

export type HermesHostId = "local" | "remote-a";

export interface ParsedAgentKey {
  readonly host: HermesHostId;
  readonly profile: string;
}

// Observed charset across every local + remote profile directory name.
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Rejects malformed keys and out-of-charset profile names instead of
// forwarding them into a remote shell command — an untrusted profile
// segment is a contract breach, not a case to sanitize-and-continue.
export const parseAgentKey = (key: string): ParsedAgentKey | undefined => {
  const idx = key.indexOf(":");
  if (idx <= 0) return undefined;
  const host = key.slice(0, idx);
  const profile = key.slice(idx + 1);
  if (host !== "local" && host !== "remote-a") return undefined;
  if (!PROFILE_NAME_RE.test(profile)) return undefined;
  return { host, profile };
};

const isDefaultProfile = (profile: string): boolean => profile === "default";

// ---------------------------------------------------------------------------
// Local filesystem reads
// ---------------------------------------------------------------------------

const LOCAL_HERMES_ROOT = join(homedir(), ".hermes");

const localProfileDir = (profile: string): string =>
  isDefaultProfile(profile) ? LOCAL_HERMES_ROOT : join(LOCAL_HERMES_ROOT, "profiles", profile);

const DISPLAY_NAME_RE = /Display name\/code:\s*(.+)/;

export const readDisplayNameFromContent = (content: string): string | undefined => {
  const value = content.match(DISPLAY_NAME_RE)?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
};

// identity-brief.md lives at <dir>/assets/identity-brief.md on some profiles
// and directly at <dir>/identity-brief.md on others (verified live on both
// the local and remote-a profile trees) — try both, first match wins.
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

const buildLocalIdentity = (profile: string): AgentIdentity => {
  const dir = localProfileDir(profile);
  const env = readEnvFields(dir);
  return {
    key: `local:${profile}`,
    displayName: readDisplayName(dir),
    matrixUserId: env.matrixUserId,
    homeRoomName: env.homeRoomName,
    hasAvatar: hasLocalAvatar(dir),
  };
};

const fetchLocalIdentityBatch = async (): Promise<Map<string, AgentIdentity>> => {
  const identities = new Map<string, AgentIdentity>();
  identities.set("default", buildLocalIdentity("default"));
  const profilesDir = join(LOCAL_HERMES_ROOT, "profiles");
  if (existsSync(profilesDir)) {
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        identities.set(entry.name, buildLocalIdentity(entry.name));
      }
    } catch {
      // profiles dir unreadable — default profile identity still stands
    }
  }
  return identities;
};

// ---------------------------------------------------------------------------
// Remote (remote-a) identity batch: ONE ssh call running a fixed POSIX sh
// script. The script string below is a fixed literal — no profile name or
// file content is ever interpolated into it; it walks the filesystem and
// emits tab-separated lines itself.
// ---------------------------------------------------------------------------

const SSH_OPTS = ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes"] as const;
const MAC_MINI = "remote-a";

const REMOTE_IDENTITY_SCRIPT = `
emit() {
  name="$1"; dir="$2"
  display=""
  for brief in "$dir/assets/identity-brief.md" "$dir/identity-brief.md"; do
    if [ -f "$brief" ]; then
      display=$(grep -m1 -E "Display name/code:" "$brief" 2>/dev/null | sed -E 's/.*Display name\\/code:[[:space:]]*//')
      [ -n "$display" ] && break
    fi
  done
  muid=""
  room=""
  env="$dir/.env"
  if [ -f "$env" ]; then
    muid=$(grep -m1 "^MATRIX_USER_ID=" "$env" 2>/dev/null | cut -d= -f2-)
    room=$(grep -m1 "^MATRIX_HOME_ROOM_NAME=" "$env" 2>/dev/null | cut -d= -f2-)
  fi
  avatar="false"
  [ -f "$dir/assets/profile-picture.png" ] && avatar="true"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$display" "$muid" "$room" "$avatar"
}
emit default "$HOME/.hermes"
if [ -d "$HOME/.hermes/profiles" ]; then
  for d in "$HOME/.hermes/profiles"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    emit "$n" "$HOME/.hermes/profiles/$n"
  done
fi
`;

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

export const parseIdentityBatchOutput = (stdout: string): Map<string, AgentIdentity> => {
  const identities = new Map<string, AgentIdentity>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const parsed = parseIdentityBatchLine(line);
    if (!parsed) continue;
    identities.set(parsed.profile, { key: `remote-a:${parsed.profile}`, ...parsed.identity });
  }
  return identities;
};

// undefined signals "the ssh call itself failed" — distinct from a Map, even
// an empty one, which means "the ssh call succeeded and the host reported
// zero profiles". fetchHostBatch below relies on that distinction to avoid
// caching a transient failure as a legitimate empty result.
const fetchRemoteIdentityBatch = async (): Promise<Map<string, AgentIdentity> | undefined> => {
  const result = await runCli("ssh", [...SSH_OPTS, MAC_MINI, REMOTE_IDENTITY_SCRIPT], 15_000);
  if (!result.ok) return undefined;
  return parseIdentityBatchOutput(result.stdout);
};

// ---------------------------------------------------------------------------
// In-memory cache: one batch fetch per host populates every profile's entry.
// A miss (stale TTL or first call) refetches the whole host, never a single
// profile — that is what keeps this to "ONE ssh call for all profiles".
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000;

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
  readonly identities: Map<string, AgentIdentity>;
}

const hostCache = new Map<HermesHostId, HostCacheEntry>();
const hostFetchInFlight = new Map<HermesHostId, Promise<Map<string, AgentIdentity>>>();

const fetchHostBatch = (host: HermesHostId): Promise<Map<string, AgentIdentity>> => {
  const inFlight = hostFetchInFlight.get(host);
  if (inFlight) return inFlight;

  const run = host === "local" ? fetchLocalIdentityBatch : fetchRemoteIdentityBatch;
  const promise = run()
    .then((identities) => {
      if (identities === undefined) {
        const previous = hostCache.get(host);
        if (!previous) {
          hostCache.set(host, {
            fetchedAt: Date.now() - CACHE_TTL_MS + FAILURE_RETRY_MS,
            identities: new Map(),
          });
        }
        return previous?.identities ?? new Map();
      }
      hostCache.set(host, { fetchedAt: Date.now(), identities });
      return identities;
    })
    .finally(() => {
      hostFetchInFlight.delete(host);
    });
  hostFetchInFlight.set(host, promise);
  return promise;
};

export const fetchAgentIdentity = async (key: string): Promise<AgentIdentity | null> => {
  const parsed = parseAgentKey(key);
  if (!parsed) return null;

  const cached = hostCache.get(parsed.host);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.identities.get(parsed.profile) ?? null;
  }

  const identities = await fetchHostBatch(parsed.host);
  return identities.get(parsed.profile) ?? null;
};

// ---------------------------------------------------------------------------
// Avatar: data URI, disk-cached under ~/.vellum/cache/avatars/. Capped at
// 4MB decoded; oversized, missing, or unreadable -> null (never throws).
// ---------------------------------------------------------------------------

const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const AVATAR_CACHE_DIR = join(homedir(), ".vellum", "cache", "avatars");

const avatarDiskPath = (host: HermesHostId, profile: string): string =>
  join(AVATAR_CACHE_DIR, `${host}-${profile}.png`);

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

// profile is already validated against PROFILE_NAME_RE by parseAgentKey, so
// it is safe to splice into the remote command literal below.
const fetchRemoteAvatarBuffer = async (profile: string): Promise<Buffer | undefined> => {
  const remotePath = isDefaultProfile(profile)
    ? "$HOME/.hermes/assets/profile-picture.png"
    : `$HOME/.hermes/profiles/${profile}/assets/profile-picture.png`;
  const result = await runCli("ssh", [...SSH_OPTS, MAC_MINI, `base64 < ${remotePath}`], 20_000);
  if (!result.ok) return undefined;
  try {
    const buf = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
};

export const fetchAgentAvatar = async (key: string): Promise<string | null> => {
  const parsed = parseAgentKey(key);
  if (!parsed) return null;

  const diskPath = avatarDiskPath(parsed.host, parsed.profile);
  if (existsSync(diskPath)) {
    try {
      const cached = readFileSync(diskPath);
      if (cached.length <= MAX_AVATAR_BYTES) return toDataUri(cached);
    } catch {
      // fall through to refetch
    }
  }

  const buf =
    parsed.host === "local"
      ? readLocalAvatarBuffer(parsed.profile)
      : await fetchRemoteAvatarBuffer(parsed.profile);
  if (!buf || buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null;

  try {
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, buf);
  } catch {
    // disk cache is best-effort only
  }

  return toDataUri(buf);
};

// ---------------------------------------------------------------------------
// Messaging: one non-interactive turn, local spawn or ssh-wrapped remote.
// ---------------------------------------------------------------------------

const MESSAGE_TIMEOUT_MS = 180_000;

// ANSI CSI sequences (colors, cursor moves) that can show up in non-quiet
// terminal output.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const SESSION_ID_LINE_RE = /^session_id:\s*\S+$/i;

// `hermes chat -q` prints a leading "session_id: <id>" line ahead of the
// actual reply (verified live) — strip that line too, not just ANSI, so the
// reply is the model's answer and not connection bookkeeping.
export const parseHermesReply = (stdout: string): string => {
  const stripped = stdout.replace(ANSI_RE, "");
  const lines = stripped.split("\n");
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
  if (lines.length > 0 && SESSION_ID_LINE_RE.test(lines[0]!.trim())) lines.shift();
  return lines.join("\n").trim();
};

// The '\'' technique: close the quote, emit an escaped literal quote, reopen
// the quote. Needed only for the remote path — ssh re-parses the whole
// remote command line in the target shell, so the text must survive that
// second parse. The local path passes text as a plain argv element (spawn,
// no shell), so no escaping is needed there.
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const fetchAgentMessage = async (key: string, text: string): Promise<AgentReply> => {
  if (text.trim().length === 0) return { ok: false, error: "empty message" };

  const parsed = parseAgentKey(key);
  if (!parsed) return { ok: false, error: `invalid agent key: ${key}` };

  // -Q (quiet) is required, not cosmetic: without it `hermes chat` prints a
  // banner + box-drawn response + session footer instead of the clean
  // "session_id: <id>\n<reply>" shape parseHermesReply expects (verified
  // live — plain `-q` alone still emits the full banner).
  const result =
    parsed.host === "local"
      ? await runCli(
          "hermes",
          isDefaultProfile(parsed.profile)
            ? ["chat", "-q", text, "-Q"]
            : ["-p", parsed.profile, "chat", "-q", text, "-Q"],
          MESSAGE_TIMEOUT_MS,
        )
      : await runCli(
          "ssh",
          [
            ...SSH_OPTS,
            MAC_MINI,
            isDefaultProfile(parsed.profile)
              ? `hermes chat -q ${shQuote(text)} -Q`
              : `hermes -p ${parsed.profile} chat -q ${shQuote(text)} -Q`,
          ],
          MESSAGE_TIMEOUT_MS,
        );

  if (!result.ok) {
    return { ok: false, error: result.error ?? "hermes chat failed" };
  }

  return { ok: true, reply: parseHermesReply(result.stdout) };
};
