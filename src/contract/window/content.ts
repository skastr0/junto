/**
 * What the window writes and stages through the content core, as it reaches
 * it: the core's own content group (src/contract/core/content.ts), forwarded
 * by main. So a change to a content rpc's payload or answer fails main's
 * forward and the window's callers in one compile, with no second contract.
 * A payload the core's schema refuses is refused at main's edge.
 *
 * The page box comment's shot purge is not here: main makes that call itself,
 * under the main-authoring gate (src/app/ipc.ts).
 */
import { Context, Layer } from "effect";
import type { RpcClient, RpcClientError } from "effect/rpc";
import { ContentRpcs } from "../core/content";
import { windowClient } from "./link";

export const ContentWindowRpcs = ContentRpcs.omit("ContentPageShotPurge");

/** The window's client of the content group. A call fails with `RpcClientError` when the link is gone. */
export class ContentWindow extends Context.Service<ContentWindow, RpcClient.FromGroup<typeof ContentWindowRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ContentWindow",
) {
  static readonly layer = Layer.effect(ContentWindow, windowClient(ContentWindowRpcs));
}
