/**
 * Main re-export of shared managed-terminal launch resolve.
 * Prefer `@shared/managed-terminal-launch` for renderer/shared consumers.
 */
export {
  resolveManagedLaunch,
  resolveManagedLaunchPlan,
  resolveTemplate,
  scrubSpawnEnv,
  buildSpawnEnv,
  type ManagedLaunchChoices,
  type ManagedLaunchPlan,
} from "@shared/managed-terminal-launch";
