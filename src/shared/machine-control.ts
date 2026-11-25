import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { MachineAbsolutePath, type MachineInstallResult } from "./machine-install";
import { RemoteHost, HostLabel, HostSshEndpoint } from "./remote-hosts";
import { HarnessId } from "./managed-terminal-templates";
import { isValidMachineName } from "./machine-identity";
import type { MachineExchangeInput, MachineExchangeData } from "./machine-exchange";
import type { MachineLogRead, MachineLogsInput } from "./machine-log";
import type { MachineSeatInput, MachineSeatRead, MachineSeatReadInput, MachineSeatStartInput, MachineSeatStarted, MachineSeatStopped } from "./machine-seat";
import { EncodedFailure } from "./failure";
import { BoatAddInput, BoatConnectData, BoatDisconnectData, BoatMachineView, BoatStatusData } from "./boat";
import type {
  MachineLinkInput, MachineLinkData, MachineLinkKeyInput, MachineLinkKeyData, MachineLinkAcceptInput, MachineLinkAcceptData,
  MachineLinkOpenInput, MachineLinkOpenData, MachineLinkRevokeInput, MachineLinkRevokeData,
} from "./machine-link";
import { MachineInstallResult as InstallResult } from "./machine-install";
import { MachineVaultView, type MachineVaultTokenData, type MachineVaultTokenInput, type VaultTokenDelivery } from "./vault";

export const MachineName = Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName)));
export const MachineBuild = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
/**
 * The release a build says it is, and when it was built: a machine's own
 * claim, shown as text and used to say which of two machines is behind. Never
 * admission or compatibility: build equality alone decides those
 * (docs/security-doctrine.md, The link).
 */
export const MachineVersion = Schema.String.pipe(Schema.check(Schema.isMaxLength(32)),
  Schema.check(Schema.isPattern(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/)));
export type MachineVersion = typeof MachineVersion.Type;
export const MachineBuiltAt = Schema.String.pipe(Schema.check(Schema.isMaxLength(32)),
  Schema.check(Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/)));
export type MachineBuiltAt = typeof MachineBuiltAt.Type;
/** Which of two machines on different builds is behind, as each says what it runs. */
export const MachineUpdateDirection = Schema.Literals(["peer-older", "this-older", "different"]);
export type MachineUpdateDirection = typeof MachineUpdateDirection.Type;
export type MachineRelease = { readonly version?: string | undefined; readonly builtAt?: string | undefined };

const versionParts = (version: string): readonly [number, number, number, string | undefined] => {
  const [core, pre] = version.split(/-(.*)/su, 2) as [string, string | undefined];
  const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
  return [major, minor, patch, pre];
};
/** Semver order, a prerelease before its release; 0 when equal. */
export const compareMachineVersions = (a: string, b: string): number => {
  const x = versionParts(a); const y = versionParts(b);
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return (x[index] as number) < (y[index] as number) ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  return x[3] < y[3] ? -1 : 1;
};
/**
 * Which machine is behind, for two machines on different builds. A peer that
 * names no version runs a build from before builds named one, so it is the
 * older; equal versions are ordered by when each was built; anything else
 * cannot be told apart.
 */
export const machineUpdateDirection = (peer: MachineRelease, own: MachineRelease): MachineUpdateDirection => {
  const valid = (value: string | undefined): value is string => value !== undefined && Schema.is(MachineVersion)(value);
  if (!valid(own.version)) return "different";
  if (!valid(peer.version)) return peer.version === undefined ? "peer-older" : "different";
  const order = compareMachineVersions(peer.version, own.version);
  if (order !== 0) return order < 0 ? "peer-older" : "this-older";
  if (peer.builtAt === undefined || own.builtAt === undefined || peer.builtAt === own.builtAt) return "different";
  return peer.builtAt < own.builtAt ? "peer-older" : "this-older";
};
export const MachineForm = Schema.Literals(["macbook", "mac-mini", "mac-studio", "mac", "linux"]);
export type MachineForm = typeof MachineForm.Type;
export const MachineKeychainStatus = Schema.Literals(["available", "unavailable", "not-applicable"]);
export type MachineKeychainStatus = typeof MachineKeychainStatus.Type;
export const MachineHarnessSignIn = Schema.Literals(["not-installed", "sign-in-unverified", "keychain-login-unavailable"]);
export type MachineHarnessSignIn = typeof MachineHarnessSignIn.Type;
export const MachineOwnStatus = Schema.Struct({
  build: MachineBuild,
  /** This build's release and build time; absent on a build from before builds named one. */
  version: Schema.optionalKey(MachineVersion),
  builtAt: Schema.optionalKey(MachineBuiltAt),
  form: MachineForm,
  // Older builds do not report this fact; absence means unknown.
  keychain: Schema.optionalKey(MachineKeychainStatus),
  installationId: InstallationId,
  machineName: MachineName,
  juntoHome: MachineAbsolutePath,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  /** Seats this machine runs right now, every canvas; absent when it could not count. */
  runningSeats: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  ready: Schema.Boolean,
});
export type MachineOwnStatus = typeof MachineOwnStatus.Type;

export const MachineStatusInput = Schema.Struct({ name: Schema.optionalKey(MachineName) });
export type MachineStatusInput = typeof MachineStatusInput.Type;
export const MachineTargetInput = Schema.Struct({ name: MachineName });
export type MachineTargetInput = typeof MachineTargetInput.Type;
export const MachinePeerIdentity = Schema.Struct({ machineName: MachineName, installationId: InstallationId });
export type MachinePeerIdentity = typeof MachinePeerIdentity.Type;
export const MachineConfigured = MachinePeerIdentity;
/**
 * A pin, as setup answers it. `keyBound` says whether the answering machine
 * lets the pinned installation in only through its link key: a closed fact
 * about its own trust, never the key, its fingerprint or its path.
 */
export const MachinePeerPin = Schema.Struct({ ...MachinePeerIdentity.fields, boundAt: Schema.String, keyBound: Schema.optionalKey(Schema.Boolean) });
export type MachinePeerPin = typeof MachinePeerPin.Type;
export const MachineHarness = Schema.Struct({ harness: HarnessId, installed: Schema.Boolean, signIn: Schema.optionalKey(MachineHarnessSignIn) }).pipe(
  Schema.check(Schema.makeFilter(row => row.signIn === undefined || (row.installed ? row.signIn !== "not-installed" : row.signIn === "not-installed"))),
);
export type MachineHarness = typeof MachineHarness.Type;
export const MachineHarnesses = Schema.Struct({
  machineName: MachineName, reachable: Schema.Boolean,
  // Older, unreachable and build-mismatched peers may not report this fact.
  keychain: Schema.optionalKey(MachineKeychainStatus),
  harnesses: Schema.Array(MachineHarness).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type MachineHarnesses = typeof MachineHarnesses.Type;
export const MachinePeerStatus = Schema.Struct({
  ...MachineHarnesses.fields,
  form: Schema.optionalKey(MachineForm),
  installationId: Schema.optionalKey(InstallationId),
  missingSecrets: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))).pipe(Schema.check(Schema.isMaxLength(256))),
  detail: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1024)))),
  /** Why the machine could not be reached: the link failure, encoded and scrubbed. */
  failure: Schema.optionalKey(EncodedFailure),
});
export type MachinePeerStatus = typeof MachinePeerStatus.Type;
/** What the automatic updater last did, for the machine list and its operator line. */
export const MachineAutoUpdateState = Schema.Literals([
  "updating", "updated", "refused-busy", "this-older", "needs-signed-release", "rolled-back", "start-failed", "stop-unconfirmed", "failed",
]);
export type MachineAutoUpdateState = typeof MachineAutoUpdateState.Type;
export const MachineAutoUpdateView = Schema.Struct({
  state: MachineAutoUpdateState,
  targetBuild: MachineBuild,
  at: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
  runningSeats: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  detail: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))),
});
export type MachineAutoUpdateView = typeof MachineAutoUpdateView.Type;

export const MachineStatusData = Schema.Union([MachineOwnStatus, MachinePeerStatus]);
export type MachineStatusData = typeof MachineStatusData.Type;
export const MachineListData = Schema.Struct({
  machines: Schema.Array(Schema.Struct({
    machine: RemoteHost, setUp: Schema.Boolean, needsUpdate: Schema.Boolean, installationId: Schema.optionalKey(InstallationId),
    /**
     * A peer that links here only by its link key: `bound`, or `line-missing`
     * when its authorized_keys line is gone, which is drift that linking again repairs.
     */
    linkKey: Schema.optionalKey(Schema.Literals(["bound", "line-missing"])),
    /** Removed machines whose link key this one may still hold: it could not be reached to remove it. */
    holdsRevokedKeys: Schema.optionalKey(Schema.Array(MachineName).pipe(Schema.check(Schema.isMaxLength(32)))),
    /** The machine's vault token, as this machine knows it: names, scope and age, never the token. */
    vault: Schema.optionalKey(MachineVaultView),
    /** The automatic updater's last attempt, when it has one for this machine. */
    autoUpdate: Schema.optionalKey(MachineAutoUpdateView),
    /**
     * `set-up` with an active pin; `installed-not-linked` when Junto is there
     * but this machine holds no active pin to it (removed, or never linked);
     * `not-installed` when this machine knows of no Junto there.
     */
    setupState: Schema.optionalKey(Schema.Literals(["not-installed", "installed-not-linked", "set-up"])),
    /** With needsUpdate: which of the two is behind, from what each last said it runs. */
    updateDirection: Schema.optionalKey(MachineUpdateDirection),
    /** What the peer last said it runs, in a hello this machine admitted: its own claim. */
    peerVersion: Schema.optionalKey(MachineVersion),
    peerBuiltAt: Schema.optionalKey(MachineBuiltAt),
  })).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type MachineListData = typeof MachineListData.Type;
export const MachineAddInput = Schema.Struct({
  name: MachineName, label: Schema.optionalKey(HostLabel), sshTarget: HostSshEndpoint,
  sshPort: RemoteHost.fields.sshPort,
  sshIdentityFile: RemoteHost.fields.sshIdentityFile,
  sshKnownHostsFile: RemoteHost.fields.sshKnownHostsFile,
  sshHostKeyAlias: RemoteHost.fields.sshHostKeyAlias,
  juntoHome: Schema.optionalKey(MachineAbsolutePath),
  installRoot: Schema.optionalKey(MachineAbsolutePath),
});
export type MachineAddInput = typeof MachineAddInput.Type;
export const MachineCopyInput = Schema.Struct({
  name: MachineName,
  bundle: Schema.optionalKey(MachineAbsolutePath),
  /** The operator's own confirm to stop running seats on a manual update; never the coordinator's. */
  stopRunningSeats: Schema.optionalKey(Schema.Boolean),
});
export type MachineCopyInput = typeof MachineCopyInput.Type;
/**
 * A removed machine that could not be reached still accepts this machine's
 * link key: the remove is done here, and Junto clears it there the next time
 * it reaches that machine. `message` is the core's own words.
 */
export const MachineRemoved = Schema.Struct({
  machineName: MachineName,
  removed: Schema.Literal(true),
  linkKept: Schema.optionalKey(Schema.Struct({ message: Schema.String, ownWords: Schema.Literal(true) })),
  /** This machine's link key for the removed machine could not be deleted. `message` is the core's own words. */
  linkKeyKept: Schema.optionalKey(Schema.Struct({ message: Schema.String, ownWords: Schema.Literal(true) })),
  /**
   * The list of machines still to clear could not be read, and was set aside
   * unchanged. `message` is the core's own words and holds no path (a
   * terminal prints each of `paths` on its own line, "Set aside at <path>").
   */
  unlinkSetAside: Schema.optionalKey(Schema.Struct({
    message: Schema.String, ownWords: Schema.Literal(true), paths: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
  })),
});
export type MachineRemoved = typeof MachineRemoved.Type;
export const MachineEmptyInput = Schema.Struct({});
/** The operator's confirm counts: zero is still shown and still confirmed. */
export const MachineTakeoverConfirm = Schema.Struct({
  seats: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  automations: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MachineTakeoverConfirm = typeof MachineTakeoverConfirm.Type;
/**
 * Replace the active pin named `machineName` on this machine, held by
 * `expectedInstallationId`, with the new installation. Without `confirm` the
 * request only answers the counts the window must show.
 */
export const MachineTakeoverInput = Schema.Struct({
  machineName: MachineName,
  installationId: InstallationId,
  /** Omitted on a preview: the far end answers the id it holds now. */
  expectedInstallationId: Schema.optionalKey(InstallationId),
  confirm: Schema.optionalKey(MachineTakeoverConfirm),
});
export type MachineTakeoverInput = typeof MachineTakeoverInput.Type;
export const MachineTakeoverData = Schema.Struct({
  machineName: MachineName,
  installationId: InstallationId,
  previousInstallationId: InstallationId,
  seats: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  automations: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  takenOver: Schema.Boolean,
});
export type MachineTakeoverData = typeof MachineTakeoverData.Type;
/** Start a take-over on the far machine that holds the old pin. */
export const MachineTakeoverRemoteInput = Schema.Struct({
  name: MachineName,
  expectedInstallationId: Schema.optionalKey(InstallationId),
  confirm: Schema.optionalKey(MachineTakeoverConfirm),
});
export type MachineTakeoverRemoteInput = typeof MachineTakeoverRemoteInput.Type;
/** A Boat machine made and sent: where it stands, and the install's receipt. */
export const BoatAddData = Schema.Struct({ machine: BoatMachineView, installed: InstallResult });
export type BoatAddData = typeof BoatAddData.Type;

export const MachineOpName = Schema.Literals([
  "machine.add", "machine.list", "machine.send", "machine.status", "machine.update",
  "machine.remove", "machine.harnesses", "machine.configure", "machine.setup", "machine.exchange",
  "machine.logs", "machine.seat-start", "machine.seat-stop", "machine.seat-read",
  "machine.boat-connect", "machine.boat-disconnect", "machine.boat-status", "machine.boat-add", "machine.boat-delete",
  "machine.wake", "machine.sleep",
  "machine.link", "machine.link-key", "machine.link-accept", "machine.link-open", "machine.link-revoke",
  "machine.vault-token", "machine.vault-receive", "machine.takeover", "machine.takeover-remote",
]);
export type MachineOpName = typeof MachineOpName.Type;
export interface MachineArgsByOp {
  readonly "machine.add": MachineAddInput;
  readonly "machine.list": typeof MachineEmptyInput.Type;
  readonly "machine.send": MachineCopyInput;
  readonly "machine.status": MachineStatusInput;
  readonly "machine.update": MachineCopyInput;
  readonly "machine.remove": MachineTargetInput;
  readonly "machine.harnesses": MachineStatusInput;
  readonly "machine.configure": MachineTargetInput;
  readonly "machine.setup": MachinePeerIdentity;
  readonly "machine.exchange": MachineExchangeInput;
  readonly "machine.logs": MachineLogsInput;
  readonly "machine.seat-start": MachineSeatStartInput;
  readonly "machine.seat-stop": MachineSeatInput;
  readonly "machine.seat-read": MachineSeatReadInput;
  readonly "machine.boat-connect": typeof MachineEmptyInput.Type;
  readonly "machine.boat-disconnect": typeof MachineEmptyInput.Type;
  readonly "machine.boat-status": typeof MachineEmptyInput.Type;
  readonly "machine.boat-add": BoatAddInput;
  readonly "machine.boat-delete": MachineTargetInput;
  readonly "machine.wake": MachineTargetInput;
  readonly "machine.sleep": MachineTargetInput;
  readonly "machine.link": MachineLinkInput;
  readonly "machine.link-key": MachineLinkKeyInput;
  readonly "machine.link-accept": MachineLinkAcceptInput;
  readonly "machine.link-open": MachineLinkOpenInput;
  readonly "machine.link-revoke": MachineLinkRevokeInput;
  readonly "machine.vault-token": MachineVaultTokenInput;
  readonly "machine.vault-receive": VaultTokenDelivery;
  readonly "machine.takeover": MachineTakeoverInput;
  readonly "machine.takeover-remote": MachineTakeoverRemoteInput;
}
export interface MachineDataByOp {
  readonly "machine.add": RemoteHost;
  readonly "machine.list": MachineListData;
  readonly "machine.send": MachineInstallResult;
  readonly "machine.status": MachineStatusData;
  readonly "machine.update": MachineInstallResult;
  readonly "machine.remove": MachineRemoved;
  readonly "machine.harnesses": MachineHarnesses;
  readonly "machine.configure": typeof MachineConfigured.Type;
  readonly "machine.setup": MachinePeerPin;
  readonly "machine.exchange": MachineExchangeData;
  readonly "machine.logs": MachineLogRead;
  readonly "machine.seat-start": MachineSeatStarted;
  readonly "machine.seat-stop": MachineSeatStopped;
  readonly "machine.seat-read": MachineSeatRead;
  readonly "machine.boat-connect": BoatConnectData;
  readonly "machine.boat-disconnect": BoatDisconnectData;
  readonly "machine.boat-status": BoatStatusData;
  readonly "machine.boat-add": BoatAddData;
  readonly "machine.boat-delete": MachineRemoved;
  readonly "machine.wake": BoatMachineView;
  readonly "machine.sleep": BoatMachineView;
  readonly "machine.link": MachineLinkData;
  readonly "machine.link-key": MachineLinkKeyData;
  readonly "machine.link-accept": MachineLinkAcceptData;
  readonly "machine.link-open": MachineLinkOpenData;
  readonly "machine.link-revoke": MachineLinkRevokeData;
  readonly "machine.vault-token": MachineVaultTokenData;
  readonly "machine.vault-receive": MachineVaultTokenData;
  readonly "machine.takeover": MachineTakeoverData;
  readonly "machine.takeover-remote": MachineTakeoverData;
}
