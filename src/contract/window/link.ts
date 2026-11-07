/**
 * The link between Electron main and one window, as both programs reach it:
 * one service, a Layer per program. Main makes a `MessageChannelMain` when a
 * trusted window asks for its link and serves on one end; the preload moves
 * the other end to the page, untouched; a test provides one end of a
 * `MessageChannel`.
 *
 * Each window group is an Effect `RpcGroup` in `src/contract/window/`, merged
 * into `WindowRpcs`. Main answers them all with one server per window
 * (`src/app/window/ipc.ts`); the window reaches each group through the client
 * service its contract exports, built with `windowClient`. A change to a
 * group's payload, success or error fails the compile of main's handlers,
 * the window's callers and their tests; a group without a handler fails
 * main's; a client of a group main does not serve fails the window's.
 *
 * The preload imports none of this: it passes the port and stays free of
 * Effect (tests/preload-effect-free.test.ts).
 */
import { Context, Effect } from "effect";
import { RpcClient, type Rpc, type RpcGroup } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../../shared/rpc-port";
import type { WindowRpcs } from "./rpcs";

export class WindowLink extends Context.Service<WindowLink, RpcPort>()("@junto/contract/WindowLink") {}

/** The window's client of one of main's window groups, on the link. */
export const windowClient = <Rpcs extends RpcGroup.Rpcs<typeof WindowRpcs> & Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  Effect.flatMap(WindowLink, (link) =>
    RpcClient.make(group).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(link))),
  );
