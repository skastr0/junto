import { Schema } from "effect";
import { MachineInstallEvent } from "./machine-install";

/**
 * A step of a machine send or update in flight, as main tells the window.
 * `id` is the id of the owner command the step belongs to, so two machines
 * can be sent to at once and each step lands on its own row.
 */
export const MachineCommandProgress = Schema.Struct({
  id: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(64)),
    Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
  ),
  event: MachineInstallEvent,
});
export type MachineCommandProgress = typeof MachineCommandProgress.Type;

/** The window decodes a step before it reads it; anything else is dropped. */
export const decodeMachineCommandProgress = Schema.decodeUnknownResult(
  MachineCommandProgress,
  { onExcessProperty: "error" },
);
