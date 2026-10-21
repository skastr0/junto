/**
 * A page box comment's shot as a seat reads it (plan 06, B7, condition 5,
 * the asking side; remote-security's condition 2 on the purge). The seat's
 * mail, the comment or a notice of it, names the shot; the page must be in
 * the seat's reach. The shot is kept here under the thread's root comment at
 * its page node, the one claim the comment's writer took and a purge
 * releases, never under the seat's mailbox or the notice. A shot this
 * machine does not hold yet is pulled from the editing machine, which serves
 * it only where a row naming it reached (shot-entitlement.ts); the seat is
 * told it is on its way. Held, it is judged again and copied into the seat's
 * workspace. Removed by the operator, it reads removed and is never pulled.
 */
import { Effect, Option } from "effect";
import { seatReachesPage } from "@shared/content-pull";
import { mailThreadOf } from "@shared/crew";
import type { Canvas } from "@shared/model";
import { asNodeId } from "@shared/physics/schema";
import { pageShotOf, threadSubjectOf } from "@shared/thread-subject";
import { materializeContentObject } from "../content/agent-access";
import { BodyPuller } from "../content/body-puller";
import { workHome } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { judgeHeldShot, type PageShotOwner } from "./page-shot-read";
import { WorkRepository } from "./repository";

/** What a seat's mail carries for its page box shot. */
export type SeatPageShot =
  /** A copy of the shot in the seat's workspace. */
  | { readonly state: "ready"; readonly path: string }
  /** Not on this machine yet: read the mail again in a moment. */
  | { readonly state: "pending" }
  /** The operator removed it; the comment and its words stay. */
  | { readonly state: "removed" };

export type SeatPageShotAt = {
  readonly canvasName: string;
  readonly canvas: Canvas;
  /** The seat reading its own mail. */
  readonly seatNodeId: string;
};

/** The claim a seat's shot is kept under: the thread's root comment, at its page node. */
export const seatShotOwner = (canvasName: string, message: { readonly messageId: string; readonly metadata?: Readonly<Record<string, unknown>> | undefined }): PageShotOwner | undefined => {
  const subject = threadSubjectOf(message);
  return subject?.kind === "page" && pageShotOf(message) !== undefined
    ? { canvasName, nodeId: subject.nodeId, recordId: mailThreadOf(message) }
    : undefined;
};

/**
 * The shot a seat's mail names, or undefined when it names none or its page
 * is out of the seat's reach (the seat learns nothing of it).
 */
export const seatPageShot = (
  at: SeatPageShotAt,
  message: { readonly messageId: string; readonly metadata?: Readonly<Record<string, unknown>> | undefined },
): Effect.Effect<SeatPageShot | undefined, never, ContentService> =>
  Effect.gen(function* () {
    const ref = pageShotOf(message);
    const owner = seatShotOwner(at.canvasName, message);
    if (ref === undefined || owner === undefined) return undefined;
    // Reach is the page's: the pull keeps the body under the resource reached.
    const reached = seatReachesPage(at.canvasName, at.canvas, asNodeId(at.seatNodeId), asNodeId(owner.nodeId));
    if (reached === undefined) return undefined;
    // Unknown counts as purged: a shot that might be removed is never shown.
    const work = yield* Effect.serviceOption(WorkRepository);
    const purged = Option.isNone(work) ? true : yield* work.value.shotPurged(owner).pipe(Effect.orElseSucceed(() => true));
    if (purged) return { state: "removed" };
    const held = yield* judgeHeldShot(ref, owner);
    if (held.ok) {
      const content = yield* ContentService;
      const placed = yield* Effect.tryPromise(() =>
        materializeContentObject({
          contentRoot: content.root,
          workHome: workHome(),
          canvasName: at.canvasName,
          targetNodeId: at.seatNodeId,
          taskId: `mail-${owner.recordId}`,
          ref: held.ref,
          name: "page-box.png",
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      return placed === undefined ? { state: "pending" } : { state: "ready", path: placed.path };
    }
    // The pull runs once per object and is never attempted for a purged comment (core-runtime).
    const puller = yield* Effect.serviceOption(BodyPuller);
    if (Option.isSome(puller)) {
      yield* puller.value.pull({ ref, owner: { kind: "message", ...owner }, reached }).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid);
    }
    return { state: "pending" };
  });
