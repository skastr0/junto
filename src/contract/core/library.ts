/**
 * The window's library reads and writes: a signal named by a preview, a page
 * box comment's shot, a signal's files pulled from the seat's machine, seat
 * guidance, squads and agent profiles. Every answer is plain data. A write
 * the repository refuses fails with `LibraryRefused`, carrying the words the
 * window shows the operator.
 *
 * Main decodes and normalizes what the window sends (a squad or profile body
 * through its shared decoder, seat guidance through its normalizer), so the
 * core is only handed what it can store.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { AgentProfile, ProfileSaveInput } from "../../shared/agent-profiles";
import { PageShotAt, PageShotRead } from "../../shared/page-shot";
import { Squad, SquadSaveInput } from "../../shared/squads";
import { AgentSignal } from "../../shared/wire/agent-signals";
import { ContentRef } from "../../shared/wire/content-ref";
import { coreClient } from "./link";

/** A library read or write that did not land, with the words the operator is shown. */
export class LibraryRefused extends Schema.TaggedError<LibraryRefused>()("LibraryRefused", {
  message: Schema.String,
}) {}

/** One seat's optional soul and instructions. */
export const SeatGuidance = Schema.Struct({
  soul: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
});
export type SeatGuidance = typeof SeatGuidance.Type;

/** Seat id -> guidance, as the renderer holds it. */
export const SeatGuidanceMap = Schema.Record(Schema.String, SeatGuidance);
export type SeatGuidanceMap = typeof SeatGuidanceMap.Type;

export const LibraryRpcs = RpcGroup.make(
  /** The signal a preview names, or null when it is not there. */
  Rpc.make("LibrarySignal", { payload: { signalId: Schema.String }, success: Schema.NullOr(AgentSignal) }),
  Rpc.make("LibraryPageShot", { payload: PageShotAt, success: PageShotRead }),
  /** Only the operator's open of a file reaches here: the seat's machine is asked for it now. Answers the signal as it then stands, or null. */
  Rpc.make("LibraryPullSignalFiles", {
    payload: { signal: AgentSignal, away: Schema.Array(ContentRef) },
    success: Schema.NullOr(AgentSignal),
  }),
  Rpc.make("LibraryGuidanceList", { success: SeatGuidanceMap, error: LibraryRefused }),
  /** One seat's guidance, already normalized by main; null clears it. Answers what the store holds now. */
  Rpc.make("LibraryGuidanceSet", {
    payload: { seatId: Schema.String, guidance: Schema.NullOr(SeatGuidance) },
    success: Schema.NullOr(SeatGuidance),
    error: LibraryRefused,
  }),
  Rpc.make("LibrarySquadsList", { success: Schema.Array(Squad), error: LibraryRefused }),
  Rpc.make("LibrarySquadSave", { payload: SquadSaveInput, success: Squad, error: LibraryRefused }),
  Rpc.make("LibrarySquadRename", {
    payload: { squadId: Schema.String, name: Schema.String },
    success: Squad,
    error: LibraryRefused,
  }),
  /** Answers the id it removed. */
  Rpc.make("LibrarySquadRemove", { payload: { squadId: Schema.String }, success: Schema.String, error: LibraryRefused }),
  Rpc.make("LibraryProfilesList", { success: Schema.Array(AgentProfile), error: LibraryRefused }),
  Rpc.make("LibraryProfileSave", { payload: ProfileSaveInput, success: AgentProfile, error: LibraryRefused }),
  Rpc.make("LibraryProfileRename", {
    payload: { profileId: Schema.String, name: Schema.String },
    success: AgentProfile,
    error: LibraryRefused,
  }),
  /** Answers the id it removed. */
  Rpc.make("LibraryProfileRemove", { payload: { profileId: Schema.String }, success: Schema.String, error: LibraryRefused }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the library group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class LibraryCore extends Context.Service<LibraryCore, RpcClient.FromGroup<typeof LibraryRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/LibraryCore",
) {
  static readonly layer = Layer.effect(LibraryCore, coreClient(LibraryRpcs));
}
