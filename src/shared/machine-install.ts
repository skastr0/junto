import { Schema } from "effect";
import { InstallationId } from "./installation-id";

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
});
export type MachineInstallInput = typeof MachineInstallInput.Type;

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
});
export type MachineInstallResult = typeof MachineInstallResult.Type;

export class MachineInstallError extends Schema.TaggedError<MachineInstallError>()("MachineInstallError", {
  message: Schema.String,
  retryable: Schema.Boolean,
  disposition: Schema.Literals(["staged", "activated", "uncertain"]),
}) {}

export const MachineSendInput = Schema.Struct({
  sshTarget: Schema.String.pipe(Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9._:@%\[\]-]+$/))),
  bundle: MachineAbsolutePath,
  juntoHome: Schema.optionalKey(MachineAbsolutePath),
  installRoot: Schema.optionalKey(MachineAbsolutePath),
  expectedInstallationId: Schema.optionalKey(InstallationId),
});
export type MachineSendInput = typeof MachineSendInput.Type;
