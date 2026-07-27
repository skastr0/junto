export {
  SshEndpoint,
  RemoteUnixSocketPath,
  parseSshEndpoint,
  parseRemoteUnixSocketPath,
  SshExitError,
  SshForwardError,
  SshInputError,
  SshIoError,
  SshOutputLimitError,
  SshSetupError,
  SshSpawnError,
  SshTimeoutError,
  type SshError,
} from "./domain";
export {
  type DaemonHandoffProgram,
  type ForwardProgram,
  type OneShotProgram,
  type ScopedStreamProgram,
} from "./program";
export {
  SshTransport,
  type ConfirmSshReady,
  type LocalForwardSocket,
  type SshCommandResult,
  type SshForwardLease,
  type SshLease,
  type SshReady,
} from "./service";
export { SshTransportLive } from "./live";
export { makeScopedPromiseRunner, type ScopedPromiseRunner } from "./scoped-runner";
export {
  // Darwin freeform deploy compiler is intentionally not public: beta keeps
  // Darwin Remote deploy capability-gated, and the freeform bash -lc mint must
  // not be reachable from the product barrel (hosts deep-import remote-plan).
  compileHerdrImageStage,
  compileLinuxReleaseBridge,
  compileLinuxRemotePreflight,
  compileLinuxRemotePreflightSource,
  compileRemotePlan,
  compileRemotePlanSource,
  compileRemoteSettingsRestore,
  compileRemoteSettingsSnapshot,
  compileRemoteSettingsStamp,
  compileRemoteTopologyEvidencePresence,
  compileRemoteTopologySealPresence,
  confineHerdrStagePath,
  confineVellumDirectory,
  confineVellumLeaf,
  HERDR_IMAGE_STAGE_DIR,
  remotePlanPathFootprint,
  remoteStationSettingsInstallPlan,
  type ConfinedRemotePath,
  type RemotePlan,
  type RemotePlanStep,
  type VellumLeafBasename,
} from "./remote-plan";
export {
  compileHermesAvatar,
  compileHermesIdentityBatch,
  hermesAvatarSource,
  hermesIdentityBatchSource,
} from "./hermes-remote-plan";
export {
  remoteCat,
  remoteHermesCli,
  remoteHerdrCli,
  remoteHostProbe,
  remoteLsofTcpListen,
  remoteLs,
  remoteProductVersion,
  remoteTailscaleServeStatus,
  remoteTestFileExists,
  remoteUname,
  remoteVellumBrowserStation,
  remoteVellumStation,
} from "./read-commands";
