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
 *
 * Aliases are short `--model` shortcuts (fable, sonnet, …). When the cache
 * already surfaces the same family under a display label ("Fable"), skip the
 * lowercase alias so the picker does not list both "Fable" and "fable".
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
    const seenIds = new Set<string>();
    const seenLabels = new Set<string>();

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
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const label = typeof rec.label === "string" ? rec.label : id;
        seenLabels.add(label.toLowerCase());
        models.push({
          id,
          label,
          description:
            typeof rec.description === "string" ? rec.description : undefined,
        });
      }
    }

    for (const alias of CLAUDE_MODEL_ALIASES) {
      if (seenIds.has(alias)) continue;
      if (seenLabels.has(alias.toLowerCase())) continue;
      seenIds.add(alias);
      seenLabels.add(alias.toLowerCase());
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

// ── Hermes: `hermes profile list` + provider_models_cache.json ─────────────

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

/**
 * Parse `~/.hermes/provider_models_cache.json`.
 * Shape: `{ [provider]: { models: string[] | { id|name|model }[], … } }`.
 * Fail-soft on per-provider 404/error bodies — only collect string ids.
 * Flat unique list (provider is not part of the spawn `-m` token for these
 * cache rows; hermes resolves via profile provider + model id).
 */
export const parseHermesProviderModelsCache = (
  raw: string,
): { models: ModelOption[]; error?: string } => {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { models: [], error: "provider_models_cache.json is not an object" };
    }
    const seen = new Set<string>();
    const models: ModelOption[] = [];

    for (const [provider, entry] of Object.entries(doc as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const modelsRaw = (entry as { models?: unknown }).models;
      if (!Array.isArray(modelsRaw)) continue;
      for (const row of modelsRaw) {
        let id: string | undefined;
        if (typeof row === "string") {
          id = row.trim();
        } else if (row && typeof row === "object") {
          const rec = row as Record<string, unknown>;
          id =
            typeof rec.id === "string"
              ? rec.id
              : typeof rec.name === "string"
                ? rec.name
                : typeof rec.model === "string"
                  ? rec.model
                  : undefined;
        }
        if (!id || seen.has(id)) continue;
        // Stale/error rows occasionally land as HTTP bodies or URLs — skip.
        if (/^https?:\/\//i.test(id) || /\b404\b/.test(id) || id.includes("\n")) {
          continue;
        }
        seen.add(id);
        models.push({
          id,
          label: id,
          description: provider,
        });
      }
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

export const readHermesModels = (
  home: string = homedir(),
  readText: ReadText = defaultReadText,
): ModelEnumerateResult => {
  const path = join(home, ".hermes", "provider_models_cache.json");
  const raw = readText(path);
  if (raw === undefined) {
    return {
      models: [],
      source: "empty",
      error: "missing ~/.hermes/provider_models_cache.json",
    };
  }
  const parsed = parseHermesProviderModelsCache(raw);
  return {
    models: parsed.models,
    source: parsed.models.length > 0 ? "cache" : "empty",
    error: parsed.error,
  };
};

// ── Pi / Prime Agent: provider/model CLI table ─────────────────────────────

/**
 * Parse the `pi --list-models` / `prime-agent model list` table:
 *
 *   provider      model              context  max-out  thinking  images
 *   google        gemini-2.5-flash   1.0M     65.5K    yes       yes
 *
 * Both harnesses accept a `provider/id` `--model` pattern (pi documented;
 * prime-agent resolves canonical provider/model references), so the picker id
 * carries the provider prefix; the label stays the bare model id.
 */
export const parseProviderModelTable = (
  stdout: string,
): { models: ModelOption[]; error?: string } => {
  const models: ModelOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Node banner lines ("(node:12345) Warning: …") are never model rows.
    if (trimmed.startsWith("(node:")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const provider = parts[0];
    const model = parts[1];
    if (!model) continue;
    // Header row ("provider      model …") — never a real model row.
    if (provider === "provider" && model === "model") continue;
    models.push({
      id: `${provider}/${model}`,
      label: model,
      description: provider,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models };
};

export type ModelsCommandRunner = () => Promise<string>;

const enumerateTableModels = async (
  run: ModelsCommandRunner,
  commandLabel: string,
): Promise<ModelEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        models: [],
        source: "empty",
        error: `${commandLabel} produced no output (stub or unavailable)`,
      };
    }
    const parsed = parseProviderModelTable(stdout);
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

export const enumeratePiModels = (
  run: ModelsCommandRunner = async () => "",
): Promise<ModelEnumerateResult> => enumerateTableModels(run, "pi --list-models");

export const enumeratePrimeAgentModels = (
  run: ModelsCommandRunner = async () => "",
): Promise<ModelEnumerateResult> =>
  enumerateTableModels(run, "prime-agent model list");

// ── Devin: `devin models list` price table ─────────────────────────────────

/**
 * Parse `devin models list` (ANSI-colored, family-grouped):
 *
 *   Claude Opus 5 (claude-opus-5)
 *     aliases: opus
 *     claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / MTok In, $25 / MTok Out]
 *
 * Model rows are the indented lines; the id is the first token and the label
 * is the bold display name. The bracket carries context + prices and becomes
 * the description (middot separators scrubbed to commas, copy law).
 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const MIDDOT_RE = /\u00B7/g;

export const parseDevinModelsList = (
  stdout: string,
): { models: ModelOption[]; error?: string } => {
  const models: ModelOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, "").replace(/\r$/, "");
    // Model rows are indented two spaces; family headers and aliases are not rows.
    if (!/^\s{2}/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("aliases:")) continue;
    const parts = trimmed.split(/\s{2,}|\t/);
    const id = parts[0];
    if (!id) continue;
    const rest = parts.slice(1).join(" ").trim();
    const bracket = rest.match(/\[.*\]$/);
    const description = bracket
      ? bracket[0].replace(MIDDOT_RE, ",")
      : undefined;
    const label = bracket ? rest.slice(0, bracket.index).trim() : rest;
    models.push({
      id,
      label: label || id,
      description: description && description.length > 0 ? description : undefined,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models };
};

export const enumerateDevinModels = async (
  run: ModelsCommandRunner = async () => "",
): Promise<ModelEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        models: [],
        source: "empty",
        error: "devin models list produced no output (stub or unavailable)",
      };
    }
    const parsed = parseDevinModelsList(stdout);
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

// ── Cursor Agent: `agent models` / `agent --list-models` ───────────────────

/**
 * Parse `agent models` (or `agent --list-models`) text:
 *
 *   Available models
 *
 *   auto - Auto (default)
 *   gpt-5.3-codex-low - Codex 5.3 Low
 *   cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
 *
 * Rows are `id - Label`. Skip the header and blanks. Fail-soft: never throw.
 * ANSI is stripped; U+00B7 middots become commas (copy law).
 */
export const parseCursorModelsList = (
  stdout: string,
): { models: ModelOption[]; error?: string } => {
  try {
    const models: ModelOption[] = [];
    const seen = new Set<string>();
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine
        .replace(ANSI_ESCAPE_RE, "")
        .replace(MIDDOT_RE, ",")
        .replace(/\r$/, "");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^available models$/i.test(trimmed)) continue;
      const sep = trimmed.indexOf(" - ");
      if (sep < 0) continue;
      const id = trimmed.slice(0, sep).trim();
      const label = trimmed.slice(sep + 3).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: label || id });
    }
    return { models };
  } catch (err) {
    return {
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const enumerateCursorModels = async (
  run: ModelsCommandRunner = async () => "",
): Promise<ModelEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        models: [],
        source: "empty",
        error: "agent models produced no output (stub or unavailable)",
      };
    }
    const parsed = parseCursorModelsList(stdout);
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

// ── Agy: `agy models` tab-separated list ───────────────────────────────────

/**
 * Parse `agy models` output:
 *
 *   Fetching available models...
 *   gemini-2.5-flash	Gemini 2.5 Flash
 *   gemini-3.7-flash-high	Gemini 3.7 Flash (High)
 *
 * Rows are tab-separated `id\tlabel`. Skips headers like "Fetching available models..."
 * and blank lines. Fail-soft: never throw.
 * ANSI is stripped; U+00B7 middots become commas (copy law).
 */
export const parseAgyModelsList = (
  stdout: string,
): { models: ModelOption[]; error?: string } => {
  try {
    const models: ModelOption[] = [];
    const seen = new Set<string>();
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine
        .replace(ANSI_ESCAPE_RE, "")
        .replace(MIDDOT_RE, ",")
        .replace(/\r$/, "");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^fetching\b/i.test(trimmed)) continue;
      const tabIndex = trimmed.indexOf("\t");
      const id = tabIndex >= 0 ? trimmed.slice(0, tabIndex).trim() : trimmed;
      const label = tabIndex >= 0 ? trimmed.slice(tabIndex + 1).trim() : id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: label || id });
    }
    return { models };
  } catch (err) {
    return {
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const enumerateAgyModels = async (
  run: ModelsCommandRunner = async () => "",
): Promise<ModelEnumerateResult> => {
  try {
    const stdout = await run();
    if (!stdout.trim()) {
      return {
        models: [],
        source: "empty",
        error: "agy models produced no output (stub or unavailable)",
      };
    }
    const parsed = parseAgyModelsList(stdout);
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
