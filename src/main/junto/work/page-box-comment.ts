/**
 * The operator's comment on a box of a page it has open (plan 06, B7). The
 * operator draws the box over the page's view (`BrowserSessionService.drawBox`)
 * and main takes the shot and stages it under the operator's stage owner,
 * keyed by a shot id. The composer shows those bytes; posting names the id,
 * so the comment carries exactly the shot the operator saw (remote-security's
 * ask), claimed on the one comment path (subject-comment.ts). A post
 * refused before the shot was claimed (its words, a mention out of reach)
 * keeps the shot staged for a retry; posted, discarded or lost, it is spent.
 * The renderer never sends bytes.
 */
import { Effect, Option } from "effect";
import { ulid } from "ulid";
import type { MailMessageId } from "@shared/crew";
import { parseNodeRef } from "@shared/node-ref";
import type { Rect } from "@shared/page-box";
import { pageBoxUrlOf, pngSize } from "@shared/page-shot";
import { asNodeId } from "@shared/physics/schema";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import { operatorActorRef } from "@shared/work-reference";
import { deriveActorSeatId } from "../actor-seat-id";
import type { BrowserResult, BrowserSessionService } from "../browser/sessions";
import { MachineRepository } from "../machines/repository";
import { PausePlane } from "../pause-plane";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";
import { contentStageOwner } from "../content/stage";
import { ModelService } from "../model/service";
import { postSubjectComment, type StagedPageShot } from "./subject-comment";

type Refused = { readonly ok: false; readonly code: "invalid" | "failed"; readonly message: string };
const refused = (code: "invalid" | "failed", message: string): Refused => ({ ok: false, code, message });

/** A drawn box with the shot main staged for it, as the composer shows it. */
export type OperatorPageBoxDraft = {
  readonly shotId: string;
  readonly rect: Rect;
  /** The page's address as the comment will carry it. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
};

export type OperatorPageBoxDrawn =
  | { readonly ok: true; readonly data: { readonly kind: "drawn"; readonly draft: OperatorPageBoxDraft } | { readonly kind: "ended" } }
  | Refused;

export type OperatorPageBoxCommented =
  | { readonly ok: true; readonly data: { readonly messageId: MailMessageId; readonly threadId: MailMessageId } }
  | Refused;

type Staged = StagedPageShot & { readonly sessionId: string; readonly owner: ContentOwner; posting: boolean };

/** The most unposted shots held at once; the oldest goes first. */
const STAGED_MAX = 8;

/** Shots drawn and not yet posted or dropped, by shot id. Known only to this process. */
const staged = new Map<string, Staged>();

const release = (owner: ContentOwner): Effect.Effect<void> =>
  Effect.serviceOption(ContentService).pipe(
    Effect.flatMap((content) => (Option.isNone(content) ? Effect.void : content.value.releaseOwner(owner).pipe(Effect.ignore))),
  );

const take = (sessionId: string, shotId: string): Staged | undefined => {
  const held = staged.get(shotId);
  if (held === undefined || held.sessionId !== sessionId) return undefined;
  staged.delete(shotId);
  return held;
};

/** Whether the shot's own stage still holds its bytes: no claim took them. */
const stillStaged = (shot: Staged): Effect.Effect<boolean> =>
  Effect.serviceOption(ContentService).pipe(
    Effect.flatMap((content) =>
      Option.isNone(content)
        ? Effect.succeed(false)
        : content.value.listRefs(shot.ref.sha256).pipe(
            Effect.map((rows) =>
              rows.some(({ owner }) =>
                owner.kind === shot.owner.kind &&
                owner.canvasName === shot.owner.canvasName &&
                owner.nodeId === shot.owner.nodeId &&
                owner.recordId === shot.owner.recordId,
              ),
            ),
            Effect.orElseSucceed(() => false),
          ),
    ),
  );

/** The page a session shows: its canvas and node. */
const pageOf = (sessions: Pick<BrowserSessionService, "state">, sessionId: string) => {
  const session = sessions.state(sessionId);
  if (!session.ok) return undefined;
  const ref = parseNodeRef(session.data.ref);
  return ref.ok ? { canvasName: ref.value.canvasName, nodeId: session.data.nodeId } : undefined;
};

/** What the operator is told of a refusal: the writer's own words when they are about the box, never the store's. */
const toldOf = (failure: WorkErrorBody): Refused =>
  failure.type === "InputError"
    ? refused("invalid", failure.message)
    : failure.type === "ScopeError"
      ? refused("invalid", "A seat mentioned here cannot reach this page.")
      : refused("failed", "The comment could not be written.");

/** The operator draws a box; main takes its shot and stages it for the composer. */
export const startOperatorPageBox = (
  sessions: Pick<BrowserSessionService, "state" | "drawBox">,
  sessionId: string,
): Effect.Effect<OperatorPageBoxDrawn> =>
  Effect.gen(function* () {
    const page = pageOf(sessions, sessionId);
    if (page === undefined) return refused("invalid", "That page is not open.");
    const drawn = yield* Effect.promise(() => sessions.drawBox(sessionId));
    if (!drawn.ok) return refused(drawn.code === "invalid" || drawn.code === "result_too_large" ? "invalid" : "failed", drawn.message);
    if (drawn.data === undefined) return { ok: true, data: { kind: "ended" } };
    const shot = drawn.data;
    const url = pageBoxUrlOf(shot.url);
    const size = pngSize(shot.png);
    if (url === undefined || size === undefined) return refused("invalid", "This page's address cannot be named on a comment.");
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return refused("failed", "The content store is unavailable.");
    const shotId = ulid();
    const stager = { canvasName: page.canvasName, nodeId: operatorActorRef(page.canvasName).nodeId };
    const owner = contentStageOwner(stager, shotId);
    const put = yield* Effect.result(content.value.put({ source: shot.png, mediaType: "image/png", owner }));
    if (put._tag === "Failure") return refused("failed", "The shot could not be stored.");
    // A drawing never posted or dropped does not hold its bytes for long.
    while (staged.size >= STAGED_MAX) {
      const [oldest, gone] = staged.entries().next().value as [string, Staged];
      staged.delete(oldest);
      yield* release(gone.owner);
    }
    staged.set(shotId, {
      sessionId,
      owner,
      stager,
      ref: { sha256: put.success.ref.sha256, byteLength: put.success.ref.byteLength },
      url: shot.url,
      scroll: shot.scroll,
      rect: shot.rect,
      posting: false,
    });
    return {
      ok: true,
      data: { kind: "drawn", draft: { shotId, rect: shot.rect, url, width: size.width, height: size.height, png: shot.png } },
    };
  });

/**
 * Post the comment with exactly the staged shot. Posted, the shot is spent;
 * refused before its claim, it stays staged for a retry.
 */
export const postOperatorPageBox = (
  sessions: Pick<BrowserSessionService, "state">,
  request: { readonly sessionId: string; readonly shotId: string; readonly text: string },
): Effect.Effect<OperatorPageBoxCommented, never, ModelService> =>
  Effect.gen(function* () {
    const shot = staged.get(request.shotId);
    if (shot === undefined || shot.sessionId !== request.sessionId) {
      return refused("invalid", "That shot was already posted or dropped: draw the box again.");
    }
    if (shot.posting) return refused("invalid", "That comment is being posted.");
    const page = pageOf(sessions, request.sessionId);
    if (page === undefined) {
      take(request.sessionId, request.shotId);
      yield* release(shot.owner);
      return refused("invalid", "That page is not open.");
    }
    const canvas = yield* Effect.flatMap(ModelService, (model) => model.canvas(page.canvasName)).pipe(Effect.result);
    if (canvas._tag === "Failure") return refused("failed", "The canvas could not be read.");
    shot.posting = true;
    const posted = yield* Effect.result(
      postSubjectComment(
        {
          text: request.text,
          actor: { kind: "operator" },
          opId: OpId.make(ulid()),
          subject: { kind: "page", nodeId: asNodeId(page.nodeId) },
          anchor: { kind: "box", ...shot.rect },
        },
        { canvas: canvas.success, canvasName: page.canvasName, people: [], pageShot: () => Effect.succeed(shot) },
      ),
    );
    shot.posting = false;
    // Posted, the claim moved the shot to the comment. Refused with the shot
    // still staged, it waits for a retry; otherwise it is spent.
    if (posted._tag === "Success" || !(yield* stillStaged(shot))) {
      take(request.sessionId, request.shotId);
      yield* release(shot.owner);
    }
    return posted._tag === "Failure"
      ? toldOf(posted.failure)
      : { ok: true, data: { messageId: posted.success.messageId, threadId: posted.success.threadId } };
  });

/**
 * Drop every staged shot of a session that ended (closed, navigated away, or
 * the app quitting), so a crop of a page does not sit on disk longer than
 * the composer could use it.
 */
export const releaseStagedShots = (sessionId: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const ended = [...staged.entries()].filter(([, shot]) => shot.sessionId === sessionId);
    for (const [shotId] of ended) staged.delete(shotId);
    return Effect.forEach(ended, ([, shot]) => release(shot.owner), { discard: true });
  });

/** Drop a staged shot the operator did not post. */
export const discardOperatorPageBox = (sessionId: string, shotId: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const shot = take(sessionId, shotId);
    return shot === undefined ? Effect.void : release(shot.owner);
  });

/** A seat's box comment as POST /comment hands it on: the lease's own owner, seat and page. */
export type SeatPageBoxRequest = {
  readonly owner: string;
  readonly sessionId: string;
  readonly seatNodeId: string;
  readonly pageRef: string;
  readonly rect: Rect;
  readonly text: string;
  readonly signal?: AbortSignal;
};

/**
 * A seat comments on a box of the page its grant opened. Main takes the shot
 * as the lease's owner (the operation gate refuses it while the operator
 * holds the page), stages it under the seat's own stage owner, and posts it
 * on the one comment path as the seat, which judges the seat's reach to the
 * page. A seat on a paused canvas does not act. The stage is let go after,
 * whatever happened: a posted shot moved to the comment.
 */
export const postSeatPageBox = (
  sessions: Pick<BrowserSessionService, "captureBoxForOwner">,
  request: SeatPageBoxRequest,
): Effect.Effect<BrowserResult<{ readonly messageId: string; readonly threadId: string }>, never, ModelService | MachineRepository | PausePlane> =>
  Effect.gen(function* () {
    const ref = parseNodeRef(request.pageRef);
    if (!ref.ok) return { ok: false, code: "invalid", message: "That page cannot be named." } as const;
    const { canvasName, nodeId } = ref.value;
    if (!(yield* PausePlane).stateFor(canvasName).playing) {
      return { ok: false, code: "forbidden", message: "This canvas is paused: a seat comments when the operator plays it." } as const;
    }
    const canvas = yield* Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(Effect.result);
    if (canvas._tag === "Failure") return { ok: false, code: "failed", message: "The canvas could not be read." } as const;
    const seat = canvas.success.nodes.get(asNodeId(request.seatNodeId));
    if (seat?.kind !== "agent") return { ok: false, code: "forbidden", message: "This grant's seat is not on the canvas." } as const;
    const installation = yield* Effect.flatMap(MachineRepository, (machines) => machines.installationId).pipe(Effect.result);
    if (installation._tag === "Failure") return { ok: false, code: "failed", message: "This machine has no installation id yet." } as const;
    const shot = yield* Effect.promise(() => sessions.captureBoxForOwner(request.owner, request.sessionId, request.rect, request.signal));
    if (!shot.ok) return shot;
    if (pageBoxUrlOf(shot.data.url) === undefined) return { ok: false, code: "invalid", message: "This page's address cannot be named on a comment." } as const;
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return { ok: false, code: "failed", message: "The content store is unavailable." } as const;
    const stager = { canvasName, nodeId: request.seatNodeId };
    const owner = contentStageOwner(stager, ulid());
    const put = yield* Effect.result(content.value.put({ source: shot.data.png, mediaType: "image/png", owner }));
    if (put._tag === "Failure") return { ok: false, code: "failed", message: "The shot could not be stored." } as const;
    const staged: StagedPageShot = {
      ref: { sha256: put.success.ref.sha256, byteLength: put.success.ref.byteLength },
      stager,
      url: shot.data.url,
      scroll: shot.data.scroll,
      rect: shot.data.rect,
    };
    const posted = yield* Effect.result(
      postSubjectComment(
        {
          text: request.text,
          actor: { kind: "seat", seatId: deriveActorSeatId(installation.success, seat.bindingId), nodeId: asNodeId(request.seatNodeId) },
          opId: OpId.make(ulid()),
          subject: { kind: "page", nodeId: asNodeId(nodeId) },
          anchor: { kind: "box", ...shot.data.rect },
        },
        { canvas: canvas.success, canvasName, people: [], pageShot: () => Effect.succeed(staged) },
      ),
    );
    yield* release(owner);
    if (posted._tag === "Success") return { ok: true, data: { messageId: posted.success.messageId, threadId: posted.success.threadId } } as const;
    // The seat is told the writer's own words: its reach, its text, its mentions.
    const failure = posted.failure;
    return failure.type === "ScopeError"
      ? { ok: false, code: "forbidden", message: failure.message }
      : failure.type === "InputError" || failure.type === "UnknownTarget"
        ? { ok: false, code: "invalid", message: failure.message }
        : { ok: false, code: "failed", message: "The comment could not be written." };
  });
