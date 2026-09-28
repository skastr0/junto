/**
 * Per-harness context readers: where a seat's session file lives, which line
 * in it says how full the context is, and where the harness keeps the model's
 * context window. Minimal on purpose. Each reader trusts only a per-request
 * record the harness itself writes after every model call (never a running
 * total), and a harness without one has no reader here at all.
 *
 * Every figure is the prompt the model saw on its latest request, cache
 * included, so all harnesses measure the same thing. Windows come from the
 * session itself where the harness records it, else from the harness's own
 * model cache or config, else (Claude) from our table, else unknown.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  claudeContextWindow,
  type ContextReading,
  type ContextWindowSource,
} from "@shared/token-pressure";
import { encodeClaudeProjectCwd, harnessSessionLocation } from "../term/session-existence";

export type SeatSessionRef = {
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
  /** The model the seat was launched with, when its launch names one. */
  readonly launchModel?: string;
  /** The seat's launch env, for harness home overrides. */
  readonly env?: Readonly<Record<string, string>>;
};

/** One session file and the parser for its lines (it may keep state). */
export type OpenedSession = {
  readonly path: string;
  readonly parse: (line: string) => ContextReading | undefined;
};

export type ContextReader = {
  /** The seat's session file, or undefined while there is none. */
  readonly open: (seat: SeatSessionRef, home: string) => OpenedSession | undefined;
};

// ── Shared helpers ──────────────────────────────────────────────────────────

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const timeOf = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e14 ? value / 1000 : value > 1e11 ? value : value * 1000;
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : Date.now();
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const parseJson = (line: string): Record<string, unknown> | undefined => {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/** A small file read once per change (keyed by mtime), for window lookups. */
const fileCache = new Map<string, { readonly mtimeMs: number; readonly value: unknown }>();
const cachedFile = <T>(path: string, read: (path: string) => T): T | undefined => {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = fileCache.get(path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.value as T;
  let value: T | undefined;
  try {
    value = read(path);
  } catch {
    value = undefined;
  }
  fileCache.set(path, { mtimeMs, value });
  return value;
};

const cachedJson = (path: string): unknown => cachedFile(path, (p) => JSON.parse(readFileSync(p, "utf8")) as unknown);

const withWindow = (
  reading: Omit<ContextReading, "window" | "windowSource">,
  window: number | undefined,
  source: ContextWindowSource,
): ContextReading => (window !== undefined && window > 0 ? { ...reading, window, windowSource: source } : reading);

// ── Claude Code ─────────────────────────────────────────────────────────────

const claudeRoot = (seat: SeatSessionRef, home: string): string =>
  seat.env?.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");

/** `<config>/projects/<cwd with / as ->/<session>.jsonl`, else one scan. */
const locateClaude = (seat: SeatSessionRef, home: string): string | undefined => {
  const projects = join(claudeRoot(seat, home), "projects");
  const name = `${seat.sessionId}.jsonl`;
  if (seat.cwd?.trim()) {
    const direct = join(projects, encodeClaudeProjectCwd(seat.cwd), name);
    if (isFile(direct)) return direct;
  }
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, name);
      if (isFile(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * The last main-thread assistant record's `message.usage`: input + cache read
 * + cache creation. Subagent (`isSidechain`) and synthetic records carry no
 * main-context usage. The transcript has no window: ours (see the table).
 */
export const parseClaudeLine = (line: string, launchModel?: string): ContextReading | undefined => {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return undefined;
  const row = parseJson(line);
  if (row === undefined || row.type !== "assistant" || row.isSidechain === true) return undefined;
  const message = record(row.message);
  const usage = record(message?.usage);
  if (usage === undefined) return undefined;
  const model = text(message?.model);
  if (model === "<synthetic>") return undefined;
  const usedTokens =
    count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  if (usedTokens === 0) return undefined;
  return withWindow(
    { usedTokens, ...(model !== undefined ? { model } : {}), at: timeOf(row.timestamp) },
    claudeContextWindow(launchModel),
    "table",
  );
};

const claude: ContextReader = {
  open: (seat, home) => {
    const path = locateClaude(seat, home);
    return path === undefined ? undefined : { path, parse: (line) => parseClaudeLine(line, seat.launchModel) };
  },
};

// ── Codex ───────────────────────────────────────────────────────────────────

const codexRoot = (seat: SeatSessionRef, home: string): string =>
  seat.env?.CODEX_HOME?.trim() || join(home, ".codex");

/** A UUIDv7 thread id carries its creation time in its first 48 bits. */
const uuidV7Time = (id: string): number | undefined => {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : undefined;
};

const isRollout = (name: string, sessionId: string): boolean =>
  name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(sessionId);

const findRollout = (dir: string, sessionId: string): string | undefined => {
  try {
    const hit = readdirSync(dir).find((name) => isRollout(name, sessionId));
    return hit === undefined ? undefined : join(dir, hit);
  } catch {
    return undefined;
  }
};

const walkForRollout = (dir: string, sessionId: string, depth: number): string | undefined => {
  if (depth > 4) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) if (isRollout(name, sessionId)) return join(dir, name);
  for (const name of names) {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = walkForRollout(child, sessionId, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

/** `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
const locateCodex = (seat: SeatSessionRef, home: string): string | undefined => {
  const root = join(codexRoot(seat, home), "sessions");
  const born = uuidV7Time(seat.sessionId);
  if (born !== undefined) {
    // Rollouts file under the local date; a day either side covers any zone.
    for (const offset of [0, -1, 1]) {
      const day = new Date(born + offset * 86_400_000);
      const dir = join(
        root,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, "0"),
        String(day.getDate()).padStart(2, "0"),
      );
      const hit = findRollout(dir, seat.sessionId);
      if (hit !== undefined) return hit;
    }
  }
  return walkForRollout(root, seat.sessionId, 0);
};

/**
 * `event_msg` / `token_count`: `info.last_token_usage.input_tokens` is the
 * prompt the model just saw (cached included), and `info.model_context_window`
 * is the exact window. `info` is null before the first model call.
 */
export const parseCodexLine = (line: string): ContextReading | undefined => {
  if (!line.includes('"token_count"')) return undefined;
  const row = parseJson(line);
  const payload = record(row?.payload);
  if (row?.type !== "event_msg" || payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  const last = record(info?.last_token_usage);
  const usedTokens = count(last?.input_tokens);
  if (usedTokens === 0) return undefined;
  return withWindow({ usedTokens, at: timeOf(row.timestamp) }, count(info?.model_context_window), "session");
};

const codex: ContextReader = {
  open: (seat, home) => {
    const path = locateCodex(seat, home);
    return path === undefined ? undefined : { path, parse: parseCodexLine };
  },
};

// ── Pi family: Pi, Oh My Pi, Prime Agent ────────────────────────────────────

/**
 * Pi-shaped transcripts: an assistant `message` carries `usage` for that one
 * request as `{input, output, cacheRead, cacheWrite, totalTokens}`. The
 * prompt is input + cacheRead + cacheWrite. Running totals
 * (`child_usage_attributed`) are other record types and never match.
 */
export const parsePiLine = (
  line: string,
  windowOf: (model: string, provider: string | undefined) => number | undefined,
): ContextReading | undefined => {
  if (!line.includes('"role":"assistant"') || !line.includes('"usage"')) return undefined;
  const row = parseJson(line);
  const message = record(row?.message);
  if (row?.type !== "message" || message?.role !== "assistant") return undefined;
  const usage = record(message.usage);
  const usedTokens = count(usage?.input) + count(usage?.cacheRead) + count(usage?.cacheWrite);
  if (usedTokens === 0) return undefined;
  const model = text(message.model);
  const provider = text(message.provider);
  return withWindow(
    { usedTokens, ...(model !== undefined ? { model } : {}), at: timeOf(row.timestamp) },
    model === undefined ? undefined : windowOf(model, provider),
    "config",
  );
};

const modelsIn = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];

/**
 * Pi's fetched model list, `{[provider]: {models: [{id, contextWindow}]}}`.
 * Its name is built from parts: the packaging audit reads the bare "store"
 * plus ".json" literal as retired Junto state, and this file is Pi's, not ours.
 */
const PI_MODELS_FILE = ["models-store", "json"].join(".");

const piWindow = (agentDir: string) => (model: string, provider: string | undefined): number | undefined => {
  const store = record(cachedJson(join(agentDir, PI_MODELS_FILE)));
  if (store === undefined) return undefined;
  const providers = provider !== undefined && store[provider] !== undefined ? [store[provider]] : Object.values(store);
  for (const entry of providers) {
    const hit = modelsIn(record(entry)?.models).find((candidate) => candidate.id === model);
    if (hit !== undefined) return count(hit.contextWindow) || undefined;
  }
  return undefined;
};

const piAgentDir = (seat: SeatSessionRef, home: string): string =>
  seat.env?.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");

/** Oh My Pi caches each provider's models in `models.db` `model_cache`. */
const ompWindow = (home: string) => (model: string, provider: string | undefined): number | undefined => {
  const rows = cachedFile(join(home, ".omp", "agent", "models.db"), (path) => {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 1_000 });
    try {
      return database
        .prepare("SELECT provider_id, models FROM model_cache")
        .all()
        .flatMap((row) =>
          typeof row.provider_id === "string" && typeof row.models === "string"
            ? [{ providerId: row.provider_id, models: row.models }]
            : [],
        );
    } finally {
      database.close();
    }
  });
  if (rows === undefined) return undefined;
  for (const row of rows) {
    // A provider id may carry a suffix: `opencode-go:models-v3:<hash>`.
    if (provider !== undefined && row.providerId.split(":")[0] !== provider) continue;
    let models: unknown;
    try {
      models = JSON.parse(row.models);
    } catch {
      continue;
    }
    const hit = modelsIn(models).find((candidate) => candidate.id === model);
    if (hit !== undefined) return count(hit.contextWindow) || undefined;
  }
  return undefined;
};

/** Prime Agent's inference catalog: `.data[] {id, specs.context_window}`. */
const primeWindow = (home: string) => (model: string, provider: string | undefined): number | undefined => {
  const cache = record(cachedJson(join(home, ".prime", "agent", "prime-inference-models-cache.json")));
  const ids = new Set([model, ...(provider !== undefined ? [`${provider}/${model}`] : [])]);
  const hit = modelsIn(cache?.data).find((candidate) => typeof candidate.id === "string" && ids.has(candidate.id));
  return hit === undefined ? undefined : count(record(hit.specs)?.context_window) || undefined;
};

const piFamily = (
  windowFor: (seat: SeatSessionRef, home: string) => (model: string, provider: string | undefined) => number | undefined,
): ContextReader => ({
  open: (seat, home) => {
    const path = harnessSessionLocation({ harness: seat.harness, sessionId: seat.sessionId, ...(seat.cwd ? { cwd: seat.cwd } : {}), home });
    if (path === undefined || !isFile(path)) return undefined;
    const windowOf = windowFor(seat, home);
    return { path, parse: (line) => parsePiLine(line, windowOf) };
  },
});

// ── Kimi Code ───────────────────────────────────────────────────────────────

/**
 * `agents/main/wire.jsonl` `usage.record`: one per model step, with the model
 * alias. The prompt is inputOther + inputCacheRead + inputCacheCreation.
 */
export const parseKimiLine = (
  line: string,
  windowOf: (model: string) => number | undefined,
): ContextReading | undefined => {
  if (!line.includes('"usage.record"')) return undefined;
  const row = parseJson(line);
  if (row?.type !== "usage.record" || (row.agentId !== undefined && row.agentId !== "main")) return undefined;
  const usage = record(row.usage);
  const usedTokens = count(usage?.inputOther) + count(usage?.inputCacheRead) + count(usage?.inputCacheCreation);
  if (usedTokens === 0) return undefined;
  const model = text(row.model);
  return withWindow(
    { usedTokens, ...(model !== undefined ? { model } : {}), at: timeOf(row.time) },
    model === undefined ? undefined : windowOf(model),
    "config",
  );
};

/** `max_context_size` under `[models."<alias>"]` in Kimi's config.toml. */
export const kimiWindowFromToml = (toml: string, model: string): number | undefined => {
  let inModel = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inModel = section[1]!.replace(/\s/g, "") === `models."${model}"`;
      continue;
    }
    if (!inModel) continue;
    const size = /^max_context_size\s*=\s*(\d+)/.exec(line);
    if (size) return Number(size[1]);
  }
  return undefined;
};

const kimiHome = (seat: SeatSessionRef, home: string): string =>
  seat.env?.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");

const kimi: ContextReader = {
  open: (seat, home) => {
    const dir = harnessSessionLocation({
      harness: "kimi",
      sessionId: seat.sessionId,
      home,
      ...(seat.cwd ? { cwd: seat.cwd } : {}),
    });
    if (dir === undefined) return undefined;
    const path = join(dir, "agents", "main", "wire.jsonl");
    if (!isFile(path)) return undefined;
    const config = join(kimiHome(seat, home), "config.toml");
    const windowOf = (model: string): number | undefined => {
      const toml = cachedFile(config, (p) => readFileSync(p, "utf8"));
      return toml === undefined ? undefined : kimiWindowFromToml(toml, model);
    };
    return { path, parse: (line) => parseKimiLine(line, windowOf) };
  },
};

// ── Muse ────────────────────────────────────────────────────────────────────

/**
 * `session.jsonl` `runtime.session` / `model_completed`: `usage.input_tokens`
 * is the full prompt of that request, cache included.
 */
export const parseMuseLine = (
  line: string,
  windowOf: (model: string) => number | undefined,
): ContextReading | undefined => {
  if (!line.includes('"model_completed"')) return undefined;
  const row = parseJson(line);
  const event = record(record(row?.payload)?.event);
  if (row?.payload_type !== "runtime.session" || event?.kind !== "model_completed") return undefined;
  const usedTokens = count(record(event.usage)?.input_tokens);
  if (usedTokens === 0) return undefined;
  const model = text(event.model);
  return withWindow(
    { usedTokens, ...(model !== undefined ? { model } : {}), at: timeOf(row.recorded_at) },
    model === undefined ? undefined : windowOf(model),
    "config",
  );
};

/** Muse's model catalogs: `model-catalog/*.json` `.rows[] {model_id, context_limit}`. */
const museWindow = (home: string) => (model: string): number | undefined => {
  const dir = join(home, ".local", "share", "muse", "model-catalog");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const hit = modelsIn(record(cachedJson(join(dir, name)))?.rows).find((row) => row.model_id === model);
    if (hit !== undefined) return count(hit.context_limit) || undefined;
  }
  return undefined;
};

const muse: ContextReader = {
  open: (seat, home) => {
    const dir = harnessSessionLocation({ harness: "muse", sessionId: seat.sessionId, home });
    if (dir === undefined) return undefined;
    const path = join(dir, "session.jsonl");
    if (!isFile(path)) return undefined;
    const windowOf = museWindow(home);
    return { path, parse: (line) => parseMuseLine(line, windowOf) };
  },
};

// ── Grok ────────────────────────────────────────────────────────────────────

const GROK_LIVE_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

/**
 * `updates.jsonl`: every streamed update carries `_meta.totalTokens`, the
 * context size now (updated mid-turn). `turn_completed.usage` sums every
 * model call in the turn and is never read.
 */
export const parseGrokLine = (line: string, windowOf: () => number | undefined): ContextReading | undefined => {
  if (!line.includes('"totalTokens"') || !line.includes('"_meta"')) return undefined;
  const row = parseJson(line);
  const params = record(row?.params);
  const update = text(record(params?.update)?.sessionUpdate);
  if (update === undefined || !GROK_LIVE_UPDATES.has(update)) return undefined;
  const usedTokens = count(record(params?._meta)?.totalTokens);
  if (usedTokens === 0) return undefined;
  return withWindow({ usedTokens, at: timeOf(row?.timestamp) }, windowOf(), "session");
};

const grok: ContextReader = {
  open: (seat, home) => {
    const dir = harnessSessionLocation({
      harness: "grok",
      sessionId: seat.sessionId,
      home,
      ...(seat.cwd ? { cwd: seat.cwd } : {}),
    });
    if (dir === undefined) return undefined;
    const path = join(dir, "updates.jsonl");
    if (!isFile(path)) return undefined;
    // `signals.json` records the session's window at the end of each turn.
    const windowOf = (): number | undefined =>
      count(record(cachedJson(join(dirname(path), "signals.json")))?.contextWindowTokens) || undefined;
    return { path, parse: (line) => parseGrokLine(line, windowOf) };
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

export const CONTEXT_READERS: Readonly<Record<string, ContextReader>> = {
  claude,
  codex,
  grok,
  kimi,
  muse,
  pi: piFamily((seat, home) => piWindow(piAgentDir(seat, home))),
  omp: piFamily((_seat, home) => ompWindow(home)),
  "prime-agent": piFamily((_seat, home) => primeWindow(home)),
};

export const contextReaderFor = (harness: string): ContextReader | undefined =>
  Object.hasOwn(CONTEXT_READERS, harness) ? CONTEXT_READERS[harness] : undefined;
