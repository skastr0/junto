/**
 * The operator's comment on a box of a page it has open (plan 06, B7). The
 * renderer sends the page's session, the box in page CSS pixels and the
 * text; main takes the shot from the operator's own view of that page and
 * posts on the one comment path (subject-comment.ts), which stores it and
 * claims it for the comment's row. The renderer never sends bytes.
 */
import { Effect } from "effect";
import { ulid } from "ulid";
import type { MailMessageId } from "@shared/crew";
import { parseNodeRef } from "@shared/node-ref";
import type { Rect } from "@shared/page-box";
import { asNodeId } from "@shared/physics/schema";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import { BROWSER_UI_SESSION_OWNER, type BrowserPageBoxShot, type BrowserSessionService } from "../browser/sessions";
import { ModelService } from "../model/service";
import { postSubjectComment } from "./subject-comment";

export type OperatorPageBoxComment = {
  readonly sessionId: string;
  readonly rect: Rect;
  readonly text: string;
};

export type OperatorPageBoxCommented =
  | { readonly ok: true; readonly data: { readonly messageId: MailMessageId; readonly threadId: MailMessageId } }
  | { readonly ok: false; readonly code: "invalid" | "failed"; readonly message: string };

const refused = (code: "invalid" | "failed", message: string): OperatorPageBoxCommented => ({ ok: false, code, message });

/** What the operator is told of a refusal: the writer's own words when they are about the box, never the store's. */
const toldOf = (failure: WorkErrorBody): OperatorPageBoxCommented =>
  failure.type === "InputError"
    ? refused("invalid", failure.message)
    : failure.type === "ScopeError"
      ? refused("invalid", "A seat mentioned here cannot reach this page.")
      : refused("failed", "The comment could not be written.");

export const postOperatorPageBox = (
  sessions: Pick<BrowserSessionService, "state" | "captureBoxForOwner">,
  request: OperatorPageBoxComment,
): Effect.Effect<OperatorPageBoxCommented, never, ModelService> =>
  Effect.gen(function* () {
    const session = sessions.state(request.sessionId);
    if (!session.ok) return refused("invalid", "That page is not open.");
    const ref = parseNodeRef(session.data.ref);
    if (!ref.ok) return refused("failed", "That page is not on a canvas.");
    const { canvasName } = ref.value;
    const canvas = yield* Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(Effect.result);
    if (canvas._tag === "Failure") return refused("failed", "The canvas could not be read.");
    // The operator's own view of the page: the shot is what the operator sees.
    const captureBox = (rect: Rect): Effect.Effect<BrowserPageBoxShot, WorkErrorBody> =>
      Effect.promise(() => sessions.captureBoxForOwner(BROWSER_UI_SESSION_OWNER, request.sessionId, rect)).pipe(
        Effect.flatMap((shot) =>
          shot.ok
            ? Effect.succeed(shot.data)
            : Effect.fail<WorkErrorBody>({ type: "InputError", message: shot.message, details: { path: "anchor", retryable: false } }),
        ),
      );
    const posted = yield* Effect.result(
      postSubjectComment(
        {
          text: request.text,
          actor: { kind: "operator" },
          opId: OpId.make(ulid()),
          subject: { kind: "page", nodeId: asNodeId(session.data.nodeId) },
          anchor: { kind: "box", ...request.rect },
        },
        { canvas: canvas.success, canvasName, people: [], captureBox },
      ),
    );
    return posted._tag === "Failure"
      ? toldOf(posted.failure)
      : { ok: true, data: { messageId: posted.success.messageId, threadId: posted.success.threadId } };
  });
