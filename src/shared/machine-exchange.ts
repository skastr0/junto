import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { CanvasName } from "./model";
import { MachineName } from "./machine-control";

const Count = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })));
const Through = Schema.String.pipe(Schema.check(Schema.isPattern(/^(0|[1-9][0-9]{0,31})$/)));

export const MachineExchangeInput = Schema.Struct({
  canvas: Schema.optionalKey(CanvasName),
  after: Schema.optionalKey(CanvasName),
});
export type MachineExchangeInput = typeof MachineExchangeInput.Type;

/** Owner diagnostics contain identities and counts only, never row payloads. */
export const MachineExchangeData = Schema.Struct({
  machineName: MachineName,
  installationId: InstallationId,
  canvases: Schema.Array(Schema.Struct({
    canvasName: CanvasName,
    canvasId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128))),
    editor: InstallationId,
    editorMachine: Schema.optionalKey(MachineName),
    seq: Count,
    cursors: Schema.Array(Schema.Struct({ writer: InstallationId, machineName: Schema.optionalKey(MachineName), through: Through })).pipe(Schema.check(Schema.isMaxLength(32))),
    links: Schema.Array(Schema.Struct({
      machineName: MachineName, installationId: InstallationId,
      sent: Count, taken: Count, waiting: Schema.Boolean,
    })).pipe(Schema.check(Schema.isMaxLength(32))),
  })).pipe(Schema.check(Schema.isMaxLength(64))),
  next: Schema.optionalKey(CanvasName),
});
export type MachineExchangeData = typeof MachineExchangeData.Type;
