import { Effect, Schema } from "effect";
import { MachineOwnStatus } from "@shared/machine-control";

const StatusResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine status"), data: MachineOwnStatus });

/** The status answer a machine gave for itself, decoded closed. */
export const decodeMachineOwnStatus = (stdout: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(StatusResponse), { onExcessProperty: "error" })(stdout.trim()).pipe(
  Effect.map(response => response.data),
  Effect.mapError(() => new Error("machine status did not match its contract")),
);
