/**
 * A seat's side of the work socket for tests of the core: the seat client
 * (`src/node/work/seat-socket.ts`) with its socket provided, so a test calls
 * one op of the work contract as a seat calls it. The test's process carries
 * the seat: JUNTO_WORK_HOME names the test's work home and JUNTO_WORK_TOKEN
 * its credential.
 */
import { Effect } from "effect";
import type { Rpc } from "effect/rpc";
import type { WorkOpName } from "../../src/shared/work-control";
import { WorkSocketLive, callWorkRpc as callSeatRpc, type WorkRefusal } from "../../src/node/work/seat-socket";

export { WorkRefusal } from "../../src/node/work/seat-socket";

type WorkRpc = Rpc.Any & Rpc.AnyWithProps & { readonly _tag: WorkOpName };

/** One work op through its contract: its arguments as the op types them, its answer as the op decodes it. */
export const callWorkRpc = <R extends WorkRpc>(rpc: R, args: Rpc.Payload<R>, timeoutMs?: number): Effect.Effect<Rpc.Success<R>, WorkRefusal> =>
  callSeatRpc(rpc, args, timeoutMs).pipe(Effect.provide(WorkSocketLive));
