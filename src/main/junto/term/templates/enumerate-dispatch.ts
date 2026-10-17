/**
 * Live model/profile enumeration for the harness picker.
 * Fail-soft: never throws; empty lists mean "accept template defaults".
 * Zero writes to harness configs.
 */
import type {
  ManagedTerminalModelsResult,
  ManagedTerminalProfilesResult,
} from "@shared/ipc";
import { isHarnessId, templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/managed-terminal-templates";
import { runCli } from "../../adapters/exec";
import {
  enumerateAgyModels,
  enumerateFxModels,
  enumerateCodexModels,
  enumerateCursorModels,
  enumerateDevinModels,
  enumerateHermesProfiles,
  enumeratePiModels,
  enumeratePrimeAgentModels,
  type ModelEnumerateResult,
  readClaudeModels,
  readGrokModels,
  readHermesModels,
} from "./enumerate-models";

// Model lists ride the adapter process plane: the harness CLI runs in its
// own process group on the resolved tool PATH, the whole tree is killed on
// timeout or abort, and app quit drains whatever is still running.
const MODEL_COMMAND_TIMEOUT_MS = 8_000;

const runCommand = async (
  binary: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> => {
  const result = await runCli(binary, args, MODEL_COMMAND_TIMEOUT_MS, signal);
  if (!result.ok) return "";
  if (result.stdout.trim()) return result.stdout;
  // Some harness CLIs print their table to stderr (prime-agent model list).
  // Prefer stdout so ambient stderr warnings (NO_COLOR/FORCE_COLOR banner)
  // never pollute a stdout table; fall back only when stdout is empty.
  return result.stderr ?? "";
};

/**
 * How a harness's models are listed.
 * - file: read from a cache or config file the harness keeps.
 * - command: one CLI call, parsed. The binary is the template's unless named.
 * - none: no list exists; the picker stays on template defaults.
 */
export type HarnessModelList =
  | { readonly kind: "file"; readonly read: () => ModelEnumerateResult }
  | {
      readonly kind: "command";
      readonly binary?: string;
      readonly args: readonly string[];
      readonly parse: (run: () => Promise<string>) => Promise<ModelEnumerateResult>;
    }
  | { readonly kind: "none" };

const command = (
  args: readonly string[],
  parse: (run: () => Promise<string>) => Promise<ModelEnumerateResult>,
  binary?: string,
): HarnessModelList => ({ kind: "command", args, parse, ...(binary ? { binary } : {}) });

const NO_LIST: HarnessModelList = { kind: "none" };

export const HARNESS_MODEL_LISTS: Readonly<Record<HarnessId, HarnessModelList>> = {
  claude: { kind: "file", read: () => readClaudeModels() },
  codex: command(["debug", "models"], enumerateCodexModels),
  grok: { kind: "file", read: () => readGrokModels() },
  // Profiles come from `hermes profile list`; models from the provider cache.
  // Cascade: profile → model (−m) → effort (--reasoning).
  hermes: { kind: "file", read: () => readHermesModels() },
  // provider/model rows (provider prefix in the id).
  pi: command(["--list-models"], enumeratePiModels),
  // The same provider/model table shape.
  "prime-agent": command(["model", "list"], enumeratePrimeAgentModels),
  // Kimi models are config-managed (config.toml [models.*]); no CLI list.
  kimi: NO_LIST,
  // A model-catalog file exists on disk but its shape is not stable enough.
  muse: NO_LIST,
  // Per-model price lines (ANSI-scrubbed).
  devin: command(["models", "list"], enumerateDevinModels),
  // `id - Label` rows (ANSI/middot scrubbed), through the `agent` alias.
  cursor: command(["models"], enumerateCursorModels, "agent"),
  // Tab-separated `id\tlabel` rows.
  agy: command(["models"], enumerateAgyModels),
  amp: NO_LIST,
  // Provider-prefixed ids, no display names.
  fx: command(["models", "--json"], enumerateFxModels),
  omp: NO_LIST,
  "junto-overseer": NO_LIST,
};

const listModels = (
  harness: HarnessId,
  signal?: AbortSignal,
): ModelEnumerateResult | Promise<ModelEnumerateResult> => {
  const list = HARNESS_MODEL_LISTS[harness];
  switch (list.kind) {
    case "file":
      return list.read();
    case "command": {
      const binary = list.binary ?? templateFor(harness).argvSpec.binary;
      return list.parse(async () => runCommand(binary, list.args, signal));
    }
    case "none":
      return { models: [], source: "empty" };
  }
};

export const enumerateManagedModels = async (
  harnessRaw: string,
  signal?: AbortSignal,
): Promise<ManagedTerminalModelsResult> => {
  if (!isHarnessId(harnessRaw)) {
    return {
      models: [],
      source: "empty",
      error: `unknown harness: ${harnessRaw}`,
      efforts: [],
    };
  }
  if (!managedHarnessEnabled(harnessRaw)) {
    return {
      models: [],
      source: "empty",
      error: `harness disabled: ${harnessRaw}`,
      efforts: [],
    };
  }
  const harness: HarnessId = harnessRaw;
  // The template's list is the truth; a harness with no effort dial has none.
  const efforts = templateFor(harness).efforts as string[];
  try {
    const result = await listModels(harness, signal);
    return { models: result.models, source: result.source, error: result.error, efforts };
  } catch (err) {
    return {
      models: [],
      source: "empty",
      error: err instanceof Error ? err.message : String(err),
      efforts,
    };
  }
};

export const enumerateManagedProfiles = async (
  signal?: AbortSignal,
): Promise<ManagedTerminalProfilesResult> => {
  // Profiles are a picker step for the managed Hermes TUI seat, so they ride
  // the terminal harness gate, not the deeper ACP integration gate.
  if (!managedHarnessEnabled("hermes")) {
    return { profiles: [], source: "empty" };
  }
  try {
    const result = await enumerateHermesProfiles(async () =>
      runCommand("hermes", ["profile", "list"], signal),
    );
    return {
      profiles: result.profiles,
      source: result.source,
      error: result.error,
    };
  } catch (err) {
    return {
      profiles: [],
      source: "empty",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
