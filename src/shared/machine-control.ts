import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { MachineAbsolutePath } from "./machine-install";
import { isValidMachineName } from "./machine-identity";

export const MachineName = Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName)));
export const MachineOwnStatus = Schema.Struct({
  build: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  installationId: InstallationId,
  machineName: MachineName,
  juntoHome: MachineAbsolutePath,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  ready: Schema.Boolean,
});
export type MachineOwnStatus = typeof MachineOwnStatus.Type;
