/**
 * Live model/profile enumeration for the harness picker.
 * Fail-soft: never throws; empty lists mean "accept template defaults".
 * Zero writes to harness configs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ManagedTerminalModelsResult,
  ManagedTerminalProfilesResult,
} from "@shared/ipc";
import { isHarnessId, templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import {
  HERMES_INTEGRATION_ENABLED,
  managedHarnessEnabled,
} from "@shared/features";
import {
  enumerateCodexModels,
  enumerateDevinModels,
  enumerateHermesProfiles,
  enumeratePiModels,
  enumeratePrimeAgentModels,
  effortsFor,
  readClaudeModels,
  readGrokModels,
  readHermesModels,
} from "./enumerate-models";

const execFileAsync = promisify(execFile);

const runCommand = async (
  binary: string,
  args: readonly string[],
): Promise<string> => {
  try {
    const { stdout, stderr } = await execFileAsync(binary, [...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const out = typeof stdout === "string" ? stdout : "";
    if (out.trim()) return out;
    // Some harness CLIs print their table to stderr (prime-agent model list).
    // Prefer stdout so ambient stderr warnings (NO_COLOR/FORCE_COLOR banner)
    // never pollute a stdout table; fall back only when stdout is empty.
    return typeof stderr === "string" ? stderr : "";
  } catch {
    return "";
  }
};

export const enumerateManagedModels = async (
  harnessRaw: string,
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
        runCommand("codex", ["debug", "models"]),
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
    // Cascade: profile → model (−m); no effort flag in v1.
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
        runCommand("pi", ["--list-models"]),
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
        runCommand("prime-agent", ["model", "list"]),
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
        runCommand("devin", ["models", "list"]),
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

export const enumerateManagedProfiles = async (): Promise<ManagedTerminalProfilesResult> => {
  if (!HERMES_INTEGRATION_ENABLED) {
    return { profiles: [], source: "empty" };
  }
  try {
    const result = await enumerateHermesProfiles(async () =>
      runCommand("hermes", ["profile", "list"]),
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
