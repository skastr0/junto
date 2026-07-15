import { Effect, Either } from "effect";
import {
  BoothClient,
  BoothConfig,
  type CreativeRequest,
  type DraftDetail,
  type DraftItem,
} from "@skastr0/booth-sdk";
import type {
  BoothDraftDetail,
  BoothDraftReadResult,
  BoothDraftRow,
  BoothDraftsResult,
  BoothRequestRow,
  BoothRequestsResult,
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
    ...(row.assetType === undefined ? {} : { assetType: row.assetType }),
    ...(row.agentName === undefined ? {} : { agentName: row.agentName }),
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

// --- draft detail (reader modal) --------------------------------------------

// booth stores media urls root-relative ("/booth-media/assets/med_x"); the
// renderer needs them absolute against the SAME origin the api base resolves
// to (media routes are unauthenticated GETs, so a plain <img src> works).
// Pure + exported for tests. A malformed base degrades to undefined — a
// missing preview, never a broken modal.
export const absoluteBoothUrl = (apiUrl: string, path: string | undefined): string | undefined => {
  if (path === undefined || path.length === 0) return undefined;
  try {
    return new URL(path, new URL(apiUrl).origin).toString();
  } catch {
    return undefined;
  }
};

// Projection onto the frozen IPC contract — exported for tests.
export const mapBoothDraftDetail = (
  detail: NonNullable<DraftDetail>,
  apiUrl: string,
): BoothDraftDetail => {
  const { draft, mediaAsset, reviewEvents } = detail;
  const mediaUrl = absoluteBoothUrl(apiUrl, mediaAsset?.boothMediaUrl);
  const thumbnailUrl = absoluteBoothUrl(apiUrl, mediaAsset?.boothThumbnailUrl);
  return {
    id: draft.draftItemId,
    projectKey: draft.projectKey,
    title: draft.title,
    status: draft.status,
    mediaKind: draft.mediaKind,
    assetType: draft.assetType,
    ...(draft.channel === undefined ? {} : { channel: draft.channel }),
    ...(draft.placement === undefined ? {} : { placement: draft.placement }),
    ...(draft.agentName === undefined ? {} : { agentName: draft.agentName }),
    ...(draft.bodyText === undefined ? {} : { bodyText: draft.bodyText }),
    ...(draft.captionText === undefined ? {} : { captionText: draft.captionText }),
    ...(mediaUrl === undefined ? {} : { mediaUrl }),
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
    ...(mediaAsset?.mimeType === undefined ? {} : { mimeType: mediaAsset.mimeType }),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    reviewEvents: reviewEvents.map((event) => ({
      id: event.reviewEventId,
      eventType: event.eventType,
      actor: event.actor,
      ...(event.body === undefined ? {} : { body: event.body }),
      createdAt: event.createdAt,
    })),
  };
};

export const fetchBoothDraftRead = (draftId: string): Promise<BoothDraftReadResult> =>
  runSdkGuarded(
    async () => {
      const result = await SdkRuntime.runPromise(
        Effect.either(
          Effect.gen(function* () {
            const booth = yield* BoothClient;
            const config = yield* BoothConfig;
            const detail = yield* booth.readDraft(draftId);
            return { detail, apiUrl: config.apiUrl };
          }),
        ),
      );
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left) };
      }
      if (result.right.detail === null) {
        return { ok: false, error: `draft ${draftId} not found` };
      }
      return { ok: true, detail: mapBoothDraftDetail(result.right.detail, result.right.apiUrl) };
    },
    (error) => ({ ok: false, error }),
  );

// --- creative requests (the cycle's entry point) -----------------------------

export const mapBoothRequestRows = (
  rows: ReadonlyArray<CreativeRequest>,
): ReadonlyArray<BoothRequestRow> =>
  rows.map((row) => ({
    id: row.requestId,
    title: row.title,
    status: row.status,
    assetType: row.assetType,
    briefSummary: row.briefSummary,
    ...(row.requester === undefined ? {} : { requester: row.requester }),
    updatedAt: row.updatedAt,
  }));

export const fetchBoothRequests = (projectKey: string): Promise<BoothRequestsResult> =>
  runSdkGuarded(
    async () => {
      const result = await SdkRuntime.runPromise(
        Effect.either(Effect.flatMap(BoothClient, (booth) => booth.listRequests(projectKey))),
      );
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left), requests: [] };
      }
      return { ok: true, requests: mapBoothRequestRows(result.right) };
    },
    (error) => ({ ok: false, error, requests: [] }),
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
