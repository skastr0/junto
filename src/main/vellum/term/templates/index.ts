/**
 * Managed-terminal template pack (Phase 5).
 * Re-exports resolve + enumeration surfaces for main-process consumers.
 */
export {
  resolveManagedLaunch,
  resolveTemplate,
  scrubSpawnEnv,
  buildSpawnEnv,
  type ManagedLaunchChoices,
} from "./resolve-launch";

export {
  readClaudeModels,
  parseClaudeModelCache,
  enumerateCodexModels,
  parseCodexDebugModels,
  readGrokModels,
  parseGrokModelsCache,
  enumerateHermesProfiles,
  parseHermesProfileList,
  effortsFor,
  type ModelOption,
  type ProfileOption,
  type ModelEnumerateResult,
  type ProfileEnumerateResult,
  type CodexModelsRunner,
  type HermesProfilesRunner,
  type ReadText,
} from "./enumerate-models";
