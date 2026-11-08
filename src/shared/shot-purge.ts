/**
 * The operator's purge of a page box comment's shot, as a row on the exchange
 * (plan 06, B7, remote-security's ruling). The machine that edits the canvas
 * writes one `shot.purged` row for the comment, its item the comment on its
 * page node. The row names the comment and nothing else: no digest, no
 * bytes, no words. Each machine finds its own copy by its claim, the message
 * owner of the comment or of a reply in its thread, releases it, and keeps
 * the comment in `content_purges`, so the shot reads removed and is never
 * pulled again.
 */
import { Schema } from "effect";
import type { InstallationId } from "./installation-id";
import { BoundedWorkId } from "./work-reference";

export const ShotPurgedResult = Schema.Struct({
  operation: Schema.Literal("shot.purged"),
  /** The comment whose shot is purged: the root of its thread. */
  messageId: BoundedWorkId,
});
export type ShotPurgedResult = typeof ShotPurgedResult.Type;

/**
 * Who receives a purge: every machine linked for the canvas, as a ruling
 * goes. A machine that never held a notice learns only that some comment on
 * a page it already sees had a shot. The one place the routing is decided.
 */
export const purgeReaches = (_machine: InstallationId): boolean => true;
