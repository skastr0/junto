/**
 * Seat generation credentials, for the one process that is not the terminal
 * plane (0.12): Electron main's browser control server admits a seat at its
 * door, and the registry that mints, suspends and revokes those credentials
 * lives in the core, where the seats are spawned (term/local-host.ts).
 *
 * Main asks here by credential and gets the status and principal back, never
 * a credential. Every publish and revocation is pushed on
 * `seatCredential.changed` as it happens, so a grant main already cached is
 * torn down at once. A credential the registry does not know answers
 * `unknown`, an answer, so the lookup has no error to act on beyond the core
 * leaving; main reads that as a stranger.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

/** The seat a process belongs to: at least one anchor, every one optional. */
export const ProcessPrincipal = Schema.Struct({
  agentKey: Schema.optional(Schema.String),
  bindingId: Schema.optional(Schema.String),
  canvasName: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
});

/** Where a credential stands in the registry (work/seat-credentials.ts). */
export const SeatCredentialLookup = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("live"),
    principal: ProcessPrincipal,
    generationId: Schema.String,
    issuedAt: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("revoked"),
    principal: ProcessPrincipal,
    generationId: Schema.String,
    reason: Schema.Literals(["replaced", "seat-closed", "offboarded"]),
  }),
  Schema.Struct({ status: Schema.Literal("suspended"), principal: ProcessPrincipal, generationId: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);

export const SeatCredentialsRpcs = RpcGroup.make(
  /** The same lookup the work socket admits on, for main's browser door. */
  Rpc.make("SeatCredentialsLookup", { payload: { credential: Schema.String }, success: SeatCredentialLookup }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the registry. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatCredentialsCore extends Context.Service<
  SeatCredentialsCore,
  RpcClient.FromGroup<typeof SeatCredentialsRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatCredentialsCore") {
  static readonly layer = Layer.effect(SeatCredentialsCore, coreClient(SeatCredentialsRpcs));
}
