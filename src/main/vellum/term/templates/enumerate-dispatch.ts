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
  enumerateCodexModels,
  enumerateHermesProfiles,
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
    const { stdout } = await execFileAsync(binary, [...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return typeof stdout === "string" ? stdout : "";
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
