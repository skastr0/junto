import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { EncodedFailure } from "./failure";
import { isValidMachineName } from "./machine-identity";

/**
 * What a take-over preview needs when a pinned machine answers as another
 * installation: the name from this machine's own list, the id it answered
 * with, and the id pinned here. Both ids are InstallationId, so the CLI's
 * printed command is fixed argv parts, never a far string.
 */
export const MachineTakeoverHint = Schema.Struct({
  machineName: Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName))),
  installationId: InstallationId,
  previousInstallationId: InstallationId,
});
export type MachineTakeoverHint = typeof MachineTakeoverHint.Type;

/**
 * What a take-over-remote preview needs when the far machine already trusts
 * another install under this machine's name (receipt 22, S4): only the name
 * from this machine's own list, the selected host's id, never far text. The
 * CLI prints `junto machine takeover-remote <machineName>` from it.
 */
export const MachineTakeoverRemoteHint = Schema.Struct({
  machineName: Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName))),
});
export type MachineTakeoverRemoteHint = typeof MachineTakeoverRemoteHint.Type;

/** The far's setup refused to pin this machine: its name or its install is pinned to another there. */
export const MachinePinRefused = Schema.Literals(["name-pinned-elsewhere", "installation-pinned-elsewhere"]);
export type MachinePinRefused = typeof MachinePinRefused.Type;

export const MachineAbsolutePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(2048)),
  Schema.check(Schema.isPattern(/^\/[^\u0000-\u001f\u007f]*$/)),
);
export const MachineBundleFile = Schema.Struct({
  path: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+$/)),
    Schema.check(Schema.makeFilter(value => !value.split("/").some(part => part === "." || part === ".."))),
  ),
  bytes: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  mode: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({minimum:0,maximum:511}))),
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});
export type MachineBundleFile = typeof MachineBundleFile.Type;
export const MachineBundleManifest = Schema.Struct({
  build: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  target: Schema.Literals(["darwin-arm64", "linux-x64"]),
  node: Schema.String,
  appVersion: Schema.String,
  files: Schema.Array(MachineBundleFile).pipe(Schema.check(Schema.isMaxLength(128))),
});
export type MachineBundleManifest = typeof MachineBundleManifest.Type;

export const MachineInstallInput = Schema.Struct({
  bundle: MachineAbsolutePath,
  juntoHome: Schema.optionalKey(MachineAbsolutePath),
  installRoot: Schema.optionalKey(MachineAbsolutePath),
  expectedInstallationId: Schema.optionalKey(InstallationId),
  /** Set only by the operator's own confirm on a manual update, never by the coordinator. */
  stopRunningSeats: Schema.optionalKey(Schema.Boolean),
});
export type MachineInstallInput = typeof MachineInstallInput.Type;

export const MachineLocalPaths = Schema.Struct({
  juntoHome: Schema.optionalKey(MachineAbsolutePath),
  installRoot: Schema.optionalKey(MachineAbsolutePath),
});
export type MachineLocalPaths = typeof MachineLocalPaths.Type;

export const MachineInstallTransition = Schema.Struct({
  /** `pinned` is the sender's own: the machine pinned this one after it answered. */
  step: Schema.Literals(["verified", "quiescent", "selected", "started", "ready", "pinned"]),
  build: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Number),
  startKey: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.Literals(["absent", "unloaded", "inactive"])),
});
export type MachineInstallTransition = typeof MachineInstallTransition.Type;
/** Closed literals; the window owns the words. */
export const MachineInstallNotice = Schema.Literals(["linger-not-enabled"]);
export type MachineInstallNotice = typeof MachineInstallNotice.Type;
export const MachineInstallEvent = Schema.Struct({
  event: Schema.Literal("machine-install"), juntoHome: MachineAbsolutePath, installRoot: MachineAbsolutePath,
  ...MachineInstallTransition.fields,
});
export type MachineInstallEvent = typeof MachineInstallEvent.Type;

export const MachineInstallResult = Schema.Struct({
  build: Schema.String,
  juntoHome: MachineAbsolutePath,
  installRoot: MachineAbsolutePath,
  directory: MachineAbsolutePath,
  serviceLabel: Schema.String,
  provider: Schema.Literals(["launchd", "systemd-user"]),
  updated: Schema.Boolean,
  disposition: Schema.Literal("ready"),
  installationId: InstallationId,
  machineName: Schema.String,
  pid: Schema.Number,
  transitions: Schema.Array(MachineInstallTransition).pipe(Schema.check(Schema.isMaxLength(5))),
  notices: Schema.optionalKey(Schema.Array(MachineInstallNotice).pipe(Schema.check(Schema.isMaxLength(8)))),
});
export type MachineInstallResult = typeof MachineInstallResult.Type;

export const MachineUninstallResult = Schema.Struct({
  juntoHome: MachineAbsolutePath,
  installRoot: MachineAbsolutePath,
  serviceLabel: Schema.String,
  disposition: Schema.Literal("stopped"),
  definitionRemoved: Schema.Literal(true),
  transitions: Schema.Array(MachineInstallTransition).pipe(Schema.check(Schema.isMaxLength(1))),
});
export type MachineUninstallResult = typeof MachineUninstallResult.Type;

/**
 * The closed list of refusals the far install names by code
 * (src/contract/core/machine-install-checks.json, which the native install
 * reads too). The code chooses the near side's words and nothing else.
 */
export const MACHINE_INSTALL_CHECKS = [
  "boat-key-not-placed",
  "bundle-manifest-invalid",
  "bundle-mismatch",
  "bundle-not-directory",
  "bundle-special-file",
  "bundle-writable-by-others",
  "core-mismatch",
  "database-copy-failed",
  "database-not-private",
  "home-lock-refused",
  "install-folder-not-ours",
  "install-lease-unavailable",
  "installation-changed",
  "installed-not-started",
  "machine-path-unsafe",
  "restore-finish-blocked",
  "restore-interrupted",
  "restore-owed",
  "running-seats-unreported",
  "seats-did-not-stop",
  "send-in-progress",
  "service-not-ours",
  "service-not-quiescent",
  "service-platform-unsupported",
  "start-and-restore-failed",
  "start-failed",
  "start-rolled-back",
  "status-unreadable",
] as const;
export const MachineInstallCheck = Schema.Literals(MACHINE_INSTALL_CHECKS);
export type MachineInstallCheck = typeof MachineInstallCheck.Type;

export class MachineInstallError extends Schema.TaggedError<MachineInstallError>()("MachineInstallError", {
  message: Schema.String,
  retryable: Schema.Boolean,
  disposition: Schema.Literals(["staged", "activated", "uncertain", "rolled-back"]),
  transitions: Schema.optionalKey(Schema.Array(MachineInstallTransition).pipe(Schema.check(Schema.isMaxLength(5)))),
  /** Seats running on the target when an update paused on them, or unknown to an older build. */
  runningSeats: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  runningSeatsUnknown: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The message is one of this core's own fixed sentences, with nothing in it
   * from stderr, a path or a peer, so the window may show it as the reason.
   * Set only where the core writes the whole sentence.
   */
  ownWords: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The pinned machine answers as another installation: what the CLI prints
   * its take-over preview from, after the words and never in them. Display
   * only: it decides nothing, and the window never shows it.
   */
  takeover: Schema.optionalKey(MachineTakeoverHint),
  /**
   * The typed chain behind the message, from the one encoder, set where this
   * machine wraps a cause. The install-local CLI never sets it: the sender
   * decodes that output closed.
   */
  failure: Schema.optionalKey(EncodedFailure),
}) {}

/** Installation finished; retry setup or connection without copying the package again. */
export class MachineSetupError extends Schema.TaggedError<MachineSetupError>()("MachineSetupError", {
  message: Schema.String,
  /** True only where sending again can finish it as it is: a link that did not open in time. */
  retryable: Schema.Boolean,
  installed: MachineInstallResult,
  /** The message is the core's own fixed words, as on MachineInstallError. */
  ownWords: Schema.optionalKey(Schema.Literal(true)),
  /** The far trusts another install under this machine's name: what the CLI prints its take-over-remote preview from. */
  takeoverRemote: Schema.optionalKey(MachineTakeoverRemoteHint),
}) {}

export const MachineSendInput = Schema.Struct({
  sshPort: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })))),
  sshIdentityFile: Schema.optionalKey(MachineAbsolutePath),
  sshKnownHostsFile: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1024)), Schema.check(Schema.isPattern(/^\/[A-Za-z0-9._/@+-]+$/)))),
  sshHostKeyAlias: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(255)), Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)))),
  sshTarget: Schema.String.pipe(Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/))),
  bundle: MachineAbsolutePath,
  juntoHome: Schema.optionalKey(MachineAbsolutePath),
  installRoot: Schema.optionalKey(MachineAbsolutePath),
  expectedInstallationId: Schema.optionalKey(InstallationId),
  stopRunningSeats: Schema.optionalKey(Schema.Boolean),
});
export type MachineSendInput = typeof MachineSendInput.Type;
