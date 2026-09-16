export {
  SshEndpoint,
  SshHostKeyPolicy,
  SshIdentityFile,
  RemoteUnixSocketPath,
  parseHostSshRoute,
  parseSshEndpoint,
  parseSshRoute,
  parseRemoteUnixSocketPath,
  SshExitError,
  SshForwardError,
  SshInputError,
  SshIoError,
  SshProcessError,
  SshOutputLimitError,
  SshSetupError,
  SshSpawnError,
  SshTimeoutError,
  type SshError,
  type SshRoute,
  type SshTarget,
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
  type SshTransportConfigShape,
  type SshTransportShape,
} from "./service";
export { SshTransportLive } from "./live";
export {
  makeScopedPromiseRunner,
  type ScopedPromiseRunner,
} from "./scoped-runner";
export {
  // Darwin freeform deploy compiler is intentionally not public: beta keeps
  // Darwin Remote deploy capability-gated, and the freeform bash -lc mint must
  // not be reachable from the product barrel (hosts deep-import remote-plan).
  compileLinuxUserlandDeploy,
  compileLinuxUserlandDeploySource,
  compileLinuxUserlandObserve,
  compileLinuxUserlandObserveSource,
  compileLinuxUserlandPreflight,
  compileLinuxUserlandPreflightSource,
  compileLinuxUserlandRestart,
  compileLinuxUserlandRestartSource,
} from "./remote-plan";
export {
  remoteCat,
  remoteHermesCli,
  remoteHostProbe,
  remoteLinuxCapabilityDoctor,
  remoteLsofTcpListen,
  remoteProductVersion,
  remoteTailscaleServeStatus,
  remoteTestFileExists,
  remoteUname,
  remoteJuntoStation,
} from "./read-commands";
