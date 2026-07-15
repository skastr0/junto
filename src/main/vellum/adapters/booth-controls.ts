import { Effect, Either } from "effect";
import { BoothClient, type DraftItem } from "@skastr0/booth-sdk";
import type {
  BoothDraftRow,
  BoothDraftsResult,
  BoothReviewAction,
  SourceWriteResult,
} from "@shared/ipc";
import { runSdkGuarded, SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";

// Deliberate Booth writes (review verdicts) plus the drafts list that feeds the
// review UI, both through @skastr0/booth-sdk's BoothClient — no `prism tools
// invoke booth` MCP detour and no `booth` CLI shell-out. Effect Schema decode
// at the SDK boundary validated every row, so the old defensive envelope
// unwrapping / tolerant row parsing is gone; a down/slow server folds to
// ok:false via the SDK's typed BoothError (never a hang — every roundtrip is
// timeout-bounded).

// --- drafts list --------------------------------------------------------

// The SDK hands back an already-decoded DraftItem (draftItemId/title/status/
// mediaKind/updatedAt all present and typed), so this is a straight projection
// onto the frozen BoothDraftRow IPC contract.
export const mapBoothDraftRows = (
  rows: ReadonlyArray<DraftItem>,
): ReadonlyArray<BoothDraftRow> =>
  rows.map((row) => ({
    id: row.draftItemId,
    title: row.title,
    status: row.status,
    kind: row.mediaKind,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));

export const fetchBoothDrafts = (projectKey: string): Promise<BoothDraftsResult> =>
  runSdkGuarded(
    async () => {
      const result = await SdkRuntime.runPromise(
        Effect.either(Effect.flatMap(BoothClient, (booth) => booth.listDrafts(projectKey))),
      );
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left), drafts: [] };
      }
      return { ok: true, drafts: mapBoothDraftRows(result.right) };
    },
    (error) => ({ ok: false, error, drafts: [] }),
  );

// --- review actions -------------------------------------------------------

// The BoothReviewAction values map 1:1 onto the server's review eventType
// literal ("comment" | "approve" | "reject" | "request_revision").
// approve/reject accept an optional body; comment/request_revision require one
// (the server 400s on a missing body) — pre-flighted here to skip a pointless
// roundtrip and give the operator an immediate reason.
const REVIEW_ACTIONS_REQUIRING_BODY: ReadonlySet<BoothReviewAction> = new Set([
  "comment",
  "request_revision",
]);

export const fetchBoothReview = (
  projectKey: string,
  draftId: string,
  action: BoothReviewAction,
  body?: string,
): Promise<SourceWriteResult> =>
  runSdkGuarded(
    async () => {
      const trimmedBody = body?.trim();
      if (REVIEW_ACTIONS_REQUIRING_BODY.has(action) && !trimmedBody) {
        return { ok: false, error: `${action} requires a non-empty body` };
      }

      const reviewBody: Record<string, unknown> = {
        projectKey,
        draftItemId: draftId,
        eventType: action,
      };
      if (trimmedBody) reviewBody.body = trimmedBody;

      // `actor` is never sent on the wire (the server injects it from auth); it
      // only seasons the operation-key digest, so a vellum-originated verdict
      // dedups within vellum's own namespace.
      const operationBody = { ...reviewBody, actor: "vellum" };

      const result = await SdkRuntime.runPromise(
        Effect.either(
          Effect.flatMap(BoothClient, (booth) =>
            booth.recordReview(reviewBody, undefined, operationBody),
          ),
        ),
      );
      return Either.isLeft(result)
        ? { ok: false, error: describeSdkError(result.left) }
        : { ok: true };
    },
    (error) => ({ ok: false, error }),
  );
