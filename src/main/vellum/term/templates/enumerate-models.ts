/**
 * Read-only model / profile enumeration for the managed-terminal picker.
 * Fail-soft: missing caches or command failures return empty lists, never throw.
 * Zero writes to harness configs.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MODEL_ALIASES,
  type HarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";

// ── Shared shapes ──────────────────────────────────────────────────────────

export type ModelOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Per-model effort list when the source provides one (Codex). */
  readonly efforts?: readonly string[];
};

export type ProfileOption = {
  readonly name: string;
  readonly model: string;
  readonly gateway?: string;
};

export type EnumerateSource = "cache" | "aliases" | "command" | "empty";

export type ModelEnumerateResult = {
  readonly models: readonly ModelOption[];
  readonly source: EnumerateSource;
  readonly error?: string;
};

export type ProfileEnumerateResult = {
  readonly profiles: readonly ProfileOption[];
  readonly source: EnumerateSource;
  readonly error?: string;
};

// ── FS helpers (injectable for tests) ──────────────────────────────────────

export type ReadText = (path: string) => string | undefined;

const defaultReadText: ReadText = (path) => {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

// ── Claude: ~/.claude.json → additionalModelOptionsCache ───────────────────

/**
 * Parse `additionalModelOptionsCache` entries plus static aliases.
 * Shape: `[{ value, label, description }]`.
 */
export const parseClaudeModelCache = (
  raw: string,
): { models: ModelOption[]; error?: string } => {
  try {
    const doc = JSON.parse(raw) as {
      additionalModelOptionsCache?: unknown;
    };
    const cache = doc.additionalModelOptionsCache;
    const models: ModelOption[] = [];
    const seen = new Set<string>();

    if (Array.isArray(cache)) {
      for (const entry of cache) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const id =
          typeof rec.value === "string"
            ? rec.value
            : typeof rec.id === "string"
              ? rec.id
              : undefined;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          label: typeof rec.label === "string" ? rec.label : id,
          description:
            typeof rec.description === "string" ? rec.description : undefined,
        });
      }
    }

    for (const alias of CLAUDE_MODEL_ALIASES) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      models.push({ id: alias, label: alias });
    }

    return { models };
  } catch (err) {
    return {
      models: CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id })),
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const readClaudeModels = (
  home: string = homedir(),
  readText: ReadText = defaultReadText,
): ModelEnumerateResult => {
  const path = join(home, ".claude.json");
  const raw = readText(path);
  if (raw === undefined) {
    return {
      models: CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id })),
      source: "aliases",
      error: "missing ~/.claude.json",
    };
  }
  const parsed = parseClaudeModelCache(raw);
  const fromCache = parsed.models.some(
    (m) => !CLAUDE_MODEL_ALIASES.includes(m.id as (typeof CLAUDE_MODEL_ALIASES)[number]),
  );
  return {
    models: parsed.models,
    source: fromCache ? "cache" : parsed.error ? "aliases" : "cache",
    error: parsed.error,
  };
};

// ── Codex: `codex debug models` (async shell — stub interface) ─────────────

/**
 * Runner for `codex debug models`. Callers supply the shell; this module only
 * parses. Default returns empty (no ambient shell from unit tests / import).
 */
export type CodexModelsRunner = () => Promise<string>;

/**
 * Best-effort parse of `codex debug models` text.
 * Accepts JSON array when the CLI ever emits it, otherwise line-oriented
 * `model [efforts…]` sketches. Fail-soft on unknown shapes.
 */
export const parseCodexDebugModels = (
  stdout: string,
): { models: ModelOption[]; error?: string } => {
  const trimmed = stdout.trim();
  if (!trimmed) return { models: [], error: "empty codex debug models output" };

  // JSON path (future / accidental machine output).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(doc)
        ? doc
        : doc && typeof doc === "object" && Array.isArray((doc as { models?: unknown }).models)
          ? (doc as { models: unknown[] }).models
          : null;
      if (!rows) return { models: [], error: "unrecognized codex models json" };
      const models: ModelOption[] = [];
      for (const row of rows) {
        if (typeof row === "string") {
          models.push({ id: row, label: row });
          continue;
        }
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const id =
          typeof rec.id === "string"
            ? rec.id
            : typeof rec.slug === "string"
              ? rec.slug
              : typeof rec.name === "string"
                ? rec.name
                : undefined;
        if (!id) continue;
        const effortsRaw = rec.efforts ?? rec.reasoning_efforts ?? rec.effort;
        const efforts = Array.isArray(effortsRaw)
          ? effortsRaw.filter((e): e is string => typeof e === "string")
          : undefined;
        models.push({
          id,
          label: typeof rec.label === "string" ? rec.label : id,
          efforts,
        });
      }
      return { models };
    } catch (err) {
      return {
        models: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Line-oriented fallback: first token = model id; trailing tokens = efforts.
  const models: ModelOption[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^model\b/i.test(t)) continue;
    const parts = t.split(/\s+/);
    const id = parts[0];
    if (!id) continue;
    const efforts = parts.slice(1).filter((p) => p.length > 0);
    models.push({
      id,
      label: id,
      ...(efforts.length > 0 ? { efforts } : {}),
    });
  }
  return { models };
};

export const enumerateCodexModels = async (
  run: CodexModelsRunner = async () => "",
): Promise<ModelEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        models: [],
        source: "empty",
        error: "codex debug models produced no output (stub or unavailable)",
      };
    }
    const parsed = parseCodexDebugModels(stdout);
    return {
      models: parsed.models,
      source: parsed.models.length > 0 ? "command" : "empty",
      error: parsed.error,
    };
  } catch (err) {
    return {
      models: [],
      source: "empty",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// ── Grok: ~/.grok/models_cache.json ────────────────────────────────────────

/**
 * Shape: `{ models: { <id>: { info: { id, name, description, … } } } }`.
 */
export const parseGrokModelsCache = (
  raw: string,
): { models: ModelOption[]; error?: string } => {
  try {
    const doc = JSON.parse(raw) as {
      models?: Record<string, { info?: Record<string, unknown> } | unknown>;
    };
    if (!doc.models || typeof doc.models !== "object") {
      return { models: [], error: "models_cache.json missing models map" };
    }
    const models: ModelOption[] = [];
    for (const [id, entry] of Object.entries(doc.models)) {
      if (!id) continue;
      const info =
        entry && typeof entry === "object" && "info" in entry
          ? (entry as { info?: Record<string, unknown> }).info
          : undefined;
      const label =
        info && typeof info.name === "string"
          ? info.name
          : info && typeof info.model === "string"
            ? info.model
            : id;
      const description =
        info && typeof info.description === "string"
          ? info.description
          : undefined;
      models.push({ id, label, description });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models };
  } catch (err) {
    return {
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const readGrokModels = (
  home: string = homedir(),
  readText: ReadText = defaultReadText,
): ModelEnumerateResult => {
  const path = join(home, ".grok", "models_cache.json");
  const raw = readText(path);
  if (raw === undefined) {
    return {
      models: [],
      source: "empty",
      error: "missing ~/.grok/models_cache.json",
    };
  }
  const parsed = parseGrokModelsCache(raw);
  return {
    models: parsed.models,
    source: parsed.models.length > 0 ? "cache" : "empty",
    error: parsed.error,
  };
};

// ── Hermes: `hermes profile list` (no --json) ──────────────────────────────

/**
 * Parse the fixed-width `hermes profile list` table.
 * Rows: `◆default  gpt-5.5  running  —  —` (ANSI-free when not a TTY).
 * Mirrors the fleet adapter parser; kept local so the template pack stays free
 * of host-registry coupling.
 */
export const parseHermesProfileList = (
  stdout: string,
): readonly ProfileOption[] => {
  const rows: ProfileOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/◆/g, "").trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/─{3,}/.test(trimmed)) continue;
    if (/^Profile\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s{2,}/).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const [name, model, gateway] = cols;
    if (!name) continue;
    rows.push({
      name,
      model: model ?? "unknown",
      gateway: gateway ?? undefined,
    });
  }
  return rows;
};

export type HermesProfilesRunner = () => Promise<string>;

export const enumerateHermesProfiles = async (
  run: HermesProfilesRunner = async () => "",
): Promise<ProfileEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        profiles: [],
        source: "empty",
        error: "hermes profile list produced no output (stub or unavailable)",
      };
    }
    const profiles = parseHermesProfileList(stdout);
    return {
      profiles,
      source: profiles.length > 0 ? "command" : "empty",
    };
  } catch (err) {
    return {
      profiles: [],
      source: "empty",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Effort list for the picker when the model enumeration does not carry one.
 * Falls back to the template's static efforts.
 */
export const effortsFor = (
  harness: HarnessId,
  model?: ModelOption,
): readonly string[] => {
  if (model?.efforts && model.efforts.length > 0) return model.efforts;
  return templateFor(harness).efforts;
};
