export { MAC_ARM64_UPDATE_FEED_URL, macArm64UpdateFeed } from "./compiled-config";
export {
  admitsRemoteAutoRollout,
  bindPreflightReceipt,
  canAuthorizeInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  remoteRolloutTargetVersion,
  type AuthorizedUpdateCandidate,
} from "./domain";
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
