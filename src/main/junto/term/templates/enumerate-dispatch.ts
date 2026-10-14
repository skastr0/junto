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
import { managedHarnessEnabled } from "@shared/features";
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
  effortsFor,
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
  const templateEfforts = templateFor(harness).efforts;

  try {
    if (harness === "claude") {
      const result = readClaudeModels();
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: effortsFor("claude") as string[],
      };
    }
    if (harness === "codex") {
      const result = await enumerateCodexModels(async () =>
        runCommand("codex", ["debug", "models"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    if (harness === "grok") {
      const result = readGrokModels();
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: effortsFor("grok") as string[],
      };
    }
    // hermes — profiles from `hermes profile list`; models from provider cache.
    // Cascade: profile → model (−m) → effort (--reasoning).
    if (harness === "hermes") {
      const result = readHermesModels();
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // pi — `pi --list-models`; provider/model rows (provider prefix in the id).
    if (harness === "pi") {
      const result = await enumeratePiModels(async () =>
        runCommand("pi", ["--list-models"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // prime-agent — `prime-agent model list`; same provider/model table shape.
    if (harness === "prime-agent") {
      const result = await enumeratePrimeAgentModels(async () =>
        runCommand("prime-agent", ["model", "list"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // devin — `devin models list`; per-model price lines (ANSI-scrubbed).
    if (harness === "devin") {
      const result = await enumerateDevinModels(async () =>
        runCommand("devin", ["models", "list"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // cursor — `agent models`; `id - Label` rows (ANSI/middot scrubbed).
    if (harness === "cursor") {
      const result = await enumerateCursorModels(async () =>
        runCommand("agent", ["models"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // fx — `fx models --json`; provider-prefixed ids, no display names.
    if (harness === "fx") {
      const result = await enumerateFxModels(async () =>
        runCommand("fx", ["models", "--json"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        // fx exposes no effort dial; the template's empty list is the truth.
        efforts: templateEfforts as string[],
      };
    }
    // agy — `agy models`; tab-separated `id\tlabel` rows.
    if (harness === "agy") {
      const result = await enumerateAgyModels(async () =>
        runCommand("agy", ["models"], signal),
      );
      return {
        models: result.models,
        source: result.source,
        error: result.error,
        efforts: templateEfforts as string[],
      };
    }
    // kimi — models are config-managed (config.toml [models.*]); no CLI list.
    // Picker shows the template efforts only (empty for kimi in v1).
    if (harness === "kimi") {
      return {
        models: [],
        source: "empty",
        efforts: templateEfforts as string[],
      };
    }
    // muse — a model-catalog file exists on disk but the shape is not stable
    // enough for v1; leave the picker on template defaults.
    if (harness === "muse") {
      return {
        models: [],
        source: "empty",
        efforts: templateEfforts as string[],
      };
    }
    return {
      models: [],
      source: "empty",
      efforts: templateEfforts as string[],
    };
  } catch (err) {
    return {
      models: [],
      source: "empty",
      error: err instanceof Error ? err.message : String(err),
      efforts: templateEfforts as string[],
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
