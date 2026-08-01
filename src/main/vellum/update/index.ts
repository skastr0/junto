export { MAC_ARM64_UPDATE_FEED_URL, macArm64UpdateFeed } from "./compiled-config";
export {
  admitsRemoteAutoRollout,
  canAuthorizeInstall,
  canOperatorInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  remoteRolloutTargetVersion,
  type AuthorizedUpdateCandidate,
} from "./domain";
export {
  admitStagedMacApp,
  type AdmitMacAppCommand,
  type AdmitStagedMacAppOptions,
} from "./admit-mac-app";
export {
  planFleetRemoteUpdates,
  remotesMayReceiveFeedVersion,
  sequentialAutoDeployHostIds,
  type FleetRemoteObservation,
  type FleetUpdatePlan,
  type FleetUpdatePlanItem,
} from "./fleet-reconciler";
export { UpdateError, updateError } from "./errors";
export {
  captureInstallAuthority,
  deferredUpdateHostHooks,
  installUpdateHostHooks,
  installUpdateProviderHandle,
  requireUpdateHostHooks,
  requireUpdateProviderHandle,
  takeInstallAuthority,
} from "./host-slot";
export { registerUpdateIpc } from "./ipc";
export { makePlatformUpdateProvider } from "./platform";
export type { UpdateHostHooks, UpdateProvider } from "./provider";
export {
  finalizeInstallAfterQuiesce,
  isMintedInstallPlan,
  makeUpdateService,
  makeUpdateServiceLayer,
  UpdateService,
  type InstallPlan,
  type UpdateServiceOptions,
} from "./service";
export {
  ensureSchemaCompatibleOrRecover,
  feedVersionUnbricks,
  runStartupSchemaRecovery,
  type SchemaRecoveryOutcome,
} from "./startup-schema-recovery";
export {
  evaluateSchemaCompatibility,
  probeInstalledStateSchema,
  type SchemaCompatibility,
} from "../state/schema-version-probe";
