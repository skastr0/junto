/**
 * Whether a machine may pull a page comment's shot (B7). The machine that
 * serves it knows the asking machine, not a seat, so it judges entitlement,
 * not reach: the shot is served only to a machine that a row naming it
 * reached, by the exchange's own rule (`entitledTo`), as the placement is now.
 *
 * Those rows are the comment's own, and the notices of it: the row each
 * recipient seat's mailbox got, which carries the thread subject with the
 * box and its shot. A notice's id is made from the comment's writer, its id,
 * the notice kind and the recipient (`subjectNoticeId`), so the notices of
 * one comment are read by key, for each seat on the asking machine: a bound
 * of primary-key reads, never a scan, and a notice of another comment is
 * never one of them, whatever bytes it names.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { MailMessageId } from "@shared/crew";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/model/base";
import { subjectNoticeId, type SubjectNoticeKind } from "@shared/subject-notice";
import { pageShotOf } from "@shared/thread-subject";
import { entitledTo, type CanvasPlacement } from "@shared/work-exchange";
import { heldMailRow } from "../work/repository";

/** The notices of a comment, each of which carries its subject. */
const COMMENT_NOTICE_KINDS: ReadonlyArray<SubjectNoticeKind> = ["comment", "mention"];

export type ShotOwner = { readonly canvasName: string; readonly nodeId: string; readonly recordId: string };

export const shotEntitled = (
  reader: SqlClient.SqlClient,
  input: {
    /** The message owner the store holds the shot under: the comment's record. */
    readonly owner: ShotOwner;
    readonly sha256: string;
    readonly machine: InstallationId;
    /** The canvas's placement now: a seat that left the machine opens nothing. */
    readonly placement: CanvasPlacement;
    /** The canvas's seat nodes. */
    readonly seats: ReadonlyArray<NodeId>;
  },
) =>
  Effect.gen(function* () {
    const { owner, sha256, machine, placement } = input;
    const names = (row: { readonly metadata: Readonly<Record<string, unknown>> | undefined } | undefined) =>
      row !== undefined && pageShotOf({ metadata: row.metadata })?.sha256 === sha256;
    const comment = yield* heldMailRow(reader, { canvasName: owner.canvasName, nodeId: owner.nodeId, messageId: owner.recordId });
    // The owner's own comment names the shot, or nothing does.
    if (comment === undefined || !names(comment)) return false;
    if (entitledTo(machine, comment.fact, placement)) return true;
    for (const seat of input.seats) {
      // Only a seat on the asking machine can hold a notice that crossed to it; entitledTo decides.
      if (placement.seatOf(seat)?.machine !== machine) continue;
      for (const kind of COMMENT_NOTICE_KINDS) {
        const messageId = subjectNoticeId({ installationId: comment.writer, sourceId: owner.recordId as MailMessageId, kind, recipient: seat });
        const notice = yield* heldMailRow(reader, { canvasName: owner.canvasName, nodeId: seat, messageId });
        if (notice !== undefined && names(notice) && entitledTo(machine, notice.fact, placement)) return true;
      }
    }
    return false;
  });
