/**
 * The operator's comment on a box of a page it has open (plan 06, B7). The
 * operator draws the box over the page's view (`BrowserSessionService.drawBox`)
 * and main takes the shot and stages it under the operator's stage owner,
 * keyed by a shot id. The composer shows those bytes; posting names the id,
 * so the comment carries exactly the shot the operator saw (remote-security's
 * ask), claimed on the one comment path (subject-comment.ts). A shot not
 * posted is dropped. The renderer never sends bytes.
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
import type { BrowserSessionService } from "../browser/sessions";
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

type Staged = StagedPageShot & { readonly sessionId: string; readonly owner: ContentOwner };

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
    });
    return {
      ok: true,
      data: { kind: "drawn", draft: { shotId, rect: shot.rect, url, width: size.width, height: size.height, png: shot.png } },
    };
  });

/** Post the comment with exactly the staged shot; the staged shot is dropped either way. */
export const postOperatorPageBox = (
  sessions: Pick<BrowserSessionService, "state">,
  request: { readonly sessionId: string; readonly shotId: string; readonly text: string },
): Effect.Effect<OperatorPageBoxCommented, never, ModelService> =>
  Effect.gen(function* () {
    const shot = take(request.sessionId, request.shotId);
    if (shot === undefined) return refused("invalid", "That shot was already posted or dropped: draw the box again.");
    const page = pageOf(sessions, request.sessionId);
    if (page === undefined) {
      yield* release(shot.owner);
      return refused("invalid", "That page is not open.");
    }
    const canvas = yield* Effect.flatMap(ModelService, (model) => model.canvas(page.canvasName)).pipe(Effect.result);
    if (canvas._tag === "Failure") {
      yield* release(shot.owner);
      return refused("failed", "The canvas could not be read.");
    }
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
    // A claimed shot moved to the comment; one not claimed lets go here.
    yield* release(shot.owner);
    return posted._tag === "Failure"
      ? toldOf(posted.failure)
      : { ok: true, data: { messageId: posted.success.messageId, threadId: posted.success.threadId } };
  });

/** Drop a staged shot the operator did not post. */
export const discardOperatorPageBox = (sessionId: string, shotId: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const shot = take(sessionId, shotId);
    return shot === undefined ? Effect.void : release(shot.owner);
  });
