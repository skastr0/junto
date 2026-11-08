/**
 * The link between Electron main and the core, as both programs reach it: one
 * service, a Layer per program. The core provides its `parentPort`; main
 * provides the port of the core process it hosts, which outlives a core
 * restart; a test provides one end of a `MessageChannel`.
 *
 * Each core group is an Effect `RpcGroup` in `src/contract/core/`, merged
 * into `CoreRpcs`. The core answers them all with one server on the link
 * (`src/core/link.ts`); main reaches each group through the client service
 * its contract exports, built with `coreClient`. A change to a group's
 * payload, success or error fails the compile of its handlers, its callers
 * and their tests; a group without a handler fails the core's; a client of a
 * group the core does not serve fails main's.
 */
import { Context, Effect } from "effect";
import { RpcClient, type Rpc, type RpcGroup } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../../shared/rpc-port";
import type { CoreRpcs } from "./rpcs";

export class CoreLink extends Context.Service<CoreLink, RpcPort>()("@junto/contract/CoreLink") {}

/** Main's client of one of the core's groups, on the link. */
export const coreClient = <Rpcs extends RpcGroup.Rpcs<typeof CoreRpcs> & Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  Effect.flatMap(CoreLink, (link) =>
    RpcClient.make(group).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(link))),
  );
