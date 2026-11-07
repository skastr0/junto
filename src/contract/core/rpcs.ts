/**
 * Every group the core serves on its link to main. The core answers them with
 * one server, so a group here without a handler fails the core's compile, and
 * a client of a group missing here fails main's (`coreClient`).
 */
import { RpcGroup } from "effect/rpc";
import { ViewStateRpcs } from "./view-state";

export const CoreRpcs = RpcGroup.make().merge(ViewStateRpcs);
