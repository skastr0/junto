/**
 * The core's one server on its link to main: every group in `CoreRpcs`,
 * answered by its handlers. A group without its handler Layer here leaves a
 * requirement no core runtime provides, and the entry fails to compile.
 */
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/rpc";
import { CoreLink } from "../contract/core/link";
import { CoreRpcs } from "../contract/core/rpcs";
import { serverProtocol } from "@shared/rpc-port";
import { ViewStateHandlers } from "./ops/ipc-view-state";

export const CoreServerLive = RpcServer.layer(CoreRpcs).pipe(
  Layer.provide(ViewStateHandlers),
  Layer.provide(Layer.effect(RpcServer.Protocol, Effect.flatMap(CoreLink, serverProtocol))),
);
