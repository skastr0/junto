/**
 * Main's handlers for a window group a test does not exercise: every rpc
 * dies if it is called, a stream rpc as a stream. A window server must serve
 * every group in `WindowRpcs`, so a test of one group gives the others these.
 */
import { Effect, Layer, Stream } from "effect";
import { RpcSchema, type Rpc, type RpcGroup } from "effect/rpc";

export const notUnderTest = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>): Layer.Layer<Rpc.ToHandler<Rpcs>> =>
  group.toLayer(
    Object.fromEntries(
      [...(group.requests.values() as Iterable<Rpc.AnyWithProps>)].map((rpc) => [
        rpc._tag,
        () => (RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.die("not under test") : Effect.die("not under test")),
      ]),
    ) as never,
  ) as Layer.Layer<Rpc.ToHandler<Rpcs>>;
