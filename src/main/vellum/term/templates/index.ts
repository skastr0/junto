/**
 * Managed-terminal template pack (Phase 5–6).
 * Re-exports resolve + enumeration surfaces for main-process consumers.
 */
export {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
  resolveTemplate,
  scrubSpawnEnv,
  buildSpawnEnv,
  type ManagedLaunchChoices,
  type ManagedLaunchPlan,
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
