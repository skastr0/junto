/**
 * Main's one server of the host groups (`src/contract/host/rpcs.ts`), on the
 * host link of the core process it hosts. Every group's handler Layer is
 * provided here, so a group in `HostRpcs` without one fails main's compile.
 */
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/rpc";
import { HostLink } from "../../contract/host/link";
import { HostRpcs } from "../../contract/host/rpcs";
import { serverProtocol } from "@shared/rpc-port";
import { ClipboardHostHandlers } from "./main-side/clipboard";
import { FilesHostHandlers } from "./main-side/files";
import { OverseerPagesHostHandlers, WindowHostHandlers } from "./main-side/overseer-pages";

export const HostServerLive = RpcServer.layer(HostRpcs).pipe(
  Layer.provide([ClipboardHostHandlers, FilesHostHandlers, OverseerPagesHostHandlers, WindowHostHandlers]),
  Layer.provide(Layer.effect(RpcServer.Protocol, Effect.flatMap(HostLink, serverProtocol))),
);
