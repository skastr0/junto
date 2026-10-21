/**
 * The operator removes a page box comment's shot (plan 06, B7,
 * remote-security's ruling). Reached only from the trusted renderer's IPC
 * under its own authoring label: never from the work socket, a seat, an
 * overseer or an automation (tests/page-shot-purge.test.ts locks that).
 * `WorkRepository.purgeShot` does the whole of it in one transaction on the
 * machine that edits the canvas: it keeps the purge, releases the claims of
 * the comment and its replies, and writes the row every machine takes. The
 * comment and its words stay; the shot reads removed.
 */
import { Effect } from "effect";
import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import { WorkRepository } from "./repository";

/** Refusals in the operator's words, never the store's. */
const toldOf = (failure: unknown): PageShotPurged => {
  const reason = (failure as { readonly _tag?: unknown; readonly reason?: unknown } | null)?._tag === "WorkAuthorityError"
    ? (failure as { readonly reason: unknown }).reason
    : undefined;
  return {
    ok: false,
    message:
      reason === "authority-mismatch"
        ? "Only the machine that edits this canvas can remove a screenshot."
        : reason === "missing-entity"
          ? "That comment has no screenshot."
          : "The screenshot could not be removed.",
  };
};

export const purgeOperatorPageShot = (request: PageShotPurgeRequest): Effect.Effect<PageShotPurged, never, WorkRepository> =>
  Effect.flatMap(WorkRepository, (work) =>
    work.purgeShot({ canvasName: request.canvasName, nodeId: request.nodeId, messageId: request.messageId }),
  ).pipe(
    Effect.map((purged): PageShotPurged => ({ ok: true, messageId: purged.comment.messageId, already: !purged.written })),
    Effect.catch((failure) => Effect.succeed(toldOf(failure))),
  );
