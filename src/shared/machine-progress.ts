import { Schema } from "effect";
import { MachineInstallEvent } from "./machine-install";
import { RequestId } from "./operator-control";

/**
 * A step of a machine send or update in flight, as main tells the window.
 * `id` is the id of the owner command the step belongs to, so two machines
 * can be sent to at once and each step lands on its own row.
 */
export const MachineCommandProgress = Schema.Struct({
  id: RequestId,
  event: MachineInstallEvent,
});
export type MachineCommandProgress = typeof MachineCommandProgress.Type;

/** The window decodes a step before it reads it; anything else is dropped. */
export const decodeMachineCommandProgress = Schema.decodeUnknownResult(
  MachineCommandProgress,
  { onExcessProperty: "error" },
);
