import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { MachineAbsolutePath, type MachineInstallResult } from "./machine-install";
import { RemoteHost, HostLabel, HostSshEndpoint } from "./remote-hosts";
import { HarnessId } from "./managed-terminal-templates";
import { isValidMachineName } from "./machine-identity";
import type { MachineExchangeInput, MachineExchangeData } from "./machine-exchange";

export const MachineName = Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName)));
export const MachineBuild = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
export const MachineForm = Schema.Literals(["macbook", "mac-mini", "mac-studio", "mac", "linux"]);
export type MachineForm = typeof MachineForm.Type;
export const MachineKeychainStatus = Schema.Literals(["available", "unavailable", "not-applicable"]);
export type MachineKeychainStatus = typeof MachineKeychainStatus.Type;
export const MachineHarnessSignIn = Schema.Literals(["not-installed", "sign-in-unverified", "keychain-login-unavailable"]);
export type MachineHarnessSignIn = typeof MachineHarnessSignIn.Type;
export const MachineOwnStatus = Schema.Struct({
  build: MachineBuild,
  form: MachineForm,
  // Older builds do not report this fact; absence means unknown.
  keychain: Schema.optionalKey(MachineKeychainStatus),
  installationId: InstallationId,
  machineName: MachineName,
  juntoHome: MachineAbsolutePath,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
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
export const MachinePeerPin = Schema.Struct({ ...MachinePeerIdentity.fields, boundAt: Schema.String });
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
});
export type MachinePeerStatus = typeof MachinePeerStatus.Type;
export const MachineStatusData = Schema.Union([MachineOwnStatus, MachinePeerStatus]);
export type MachineStatusData = typeof MachineStatusData.Type;
export const MachineListData = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ machine: RemoteHost, setUp: Schema.Boolean, needsUpdate: Schema.Boolean, installationId: Schema.optionalKey(InstallationId) })).pipe(Schema.check(Schema.isMaxLength(32))),
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
export const MachineCopyInput = Schema.Struct({ name: MachineName, bundle: Schema.optionalKey(MachineAbsolutePath) });
export type MachineCopyInput = typeof MachineCopyInput.Type;
export const MachineRemoved = Schema.Struct({ machineName: MachineName, removed: Schema.Literal(true) });
export type MachineRemoved = typeof MachineRemoved.Type;
export const MachineEmptyInput = Schema.Struct({});

export const MachineOpName = Schema.Literals([
  "machine.add", "machine.list", "machine.send", "machine.status", "machine.update",
  "machine.remove", "machine.harnesses", "machine.configure", "machine.setup", "machine.exchange",
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
}
