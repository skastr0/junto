/**
 * The link the core's calls to Electron main ride, as both programs reach it:
 * one service, a Layer per program. These are the host groups, the mirror of
 * the core groups (`src/contract/core/link.ts`) in the other direction, on the
 * same port.
 *
 * Each host group is an Effect `RpcGroup` in `src/contract/host/`, merged into
 * `HostRpcs`. Main answers them all with one server (`src/app/core-process/
 * host-server.ts`) on a `peersLink`, because each core numbers its clients
 * from its own start and a core restarts. The core reaches each group through
 * the client service its contract exports, built with `hostClient`. A change
 * to a group's payload, success or error fails the compile of main's handlers,
 * the core's callers and their tests; a group without a handler fails main's;
 * a client of a group main does not serve fails the core's.
 *
 * A core with no window provides `noWindowLink` (`src/core/host-clients.ts`),
 * and every host call it makes fails with an `RpcClientError` that names it.
 */
import { Context, Effect } from "effect";
import { RpcClient, type Rpc, type RpcGroup } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../../shared/rpc-port";
import type { HostRpcs } from "./rpcs";

export class HostLink extends Context.Service<HostLink, RpcPort>()("@junto/contract/HostLink") {}

/** The core's client of one of main's host groups, on the link. */
export const hostClient = <Rpcs extends RpcGroup.Rpcs<typeof HostRpcs> & Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  Effect.flatMap(HostLink, (link) =>
    RpcClient.make(group).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(link))),
  );
