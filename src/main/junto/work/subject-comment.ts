/**
 * The one write path for a comment on a resource (plan 0.10, 03 section 4;
 * the contract is src/shared/subject-comment.ts). `junto task comment`,
 * `junto artifact comment`, page comments and a reply to a subject notice
 * all post here.
 *
 * 1. The poster reaches the subject's node (region-reach); the operator
 *    always does. A seat it mentions must be in reach of the node too.
 * 2. The comment's own row is held at the subject's node, its id derived
 *    from (installation, opId), so a retried write is the same row.
 *    A seat posts as itself, the operator as operator mail, an automation
 *    as its own node (actor-mail.ts).
 * 3. One notice per seat owed one: the resource's people, everyone it
 *    mentions, and everyone who posted in the thread before, never the
 *    poster. A mentioned seat's notice is a mention; the rest are comments.
 *
 * A page box comment (B7, remote-security's screenshot ruling) sends only
 * the box. The caller hands in `pageShot`, bound to its own right to the
 * live page (the operator's view, or a seat's live browser grant on this
 * machine): the shot main took, staged to the writer. The writer claims it
 * from the writer's own stage owner for the comment's own record before
 * the row is written, so a shot another writer staged, or one already
 * used, is refused. A failed write lets the claim go. Nothing of the shot
 * is told beyond its digest and size.
 */
import { Effect, Option, Schema } from "effect";
import type { MailMessageId } from "@shared/crew";
import { mentionsOf } from "@shared/mention";
import type { Canvas } from "@shared/model";
import { asNodeId } from "@shared/model";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { isCommentableKind, reaches, seatReachesTaskNode, seatsInReach } from "@shared/region-reach";
import type { ResourceActor } from "@shared/resource-command";
import {
  commentSubjectOf,
  commentThreadOf,
  subjectCommentId,
  type SubjectCommented,
  type SubjectCommentInput,
} from "@shared/subject-comment";
import { subjectNoticeRecipients, subjectNoticeRow } from "@shared/subject-notice";
import { makeUserMessage } from "@shared/task";
import {
  BoxAnchor,
  isRelativePath,
  PageBoxAnchor,
  sameSubject,
  subjectLabel,
  threadSubjectMetadata,
  threadSubjectOf,
  type ResourceSubject,
} from "@shared/thread-subject";
import type { Rect } from "@shared/page-box";
import { pageBoxUrlOf } from "@shared/page-shot";
import { operatorActorRef } from "@shared/work-reference";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";
import { claimStagedContent, type ContentStageSeat } from "../content/stage";
import type { WorkErrorBody } from "@shared/work-control";
import { mailExtensionMetadata, mailThreadOf } from "@shared/crew";
import { MachineRepository } from "../machines/repository";
import { actorMailOf } from "./actor-mail";
import { noteResourceChanged, noteThreadChanged } from "./resource-changes";
import { WorkService } from "./service";

/** What the caller knows of the resource beside the comment. */
export type SubjectCommentContext = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  /** The resource's people: a task's assignee and seat reviewers, an artifact's author. */
  readonly people: ReadonlyArray<NodeId>;
  /**
   * A page box's shot from the live page, bound to the writer's own right to
   * it, staged in the content store. Without it a page comment names no box.
   */
  readonly pageShot?: (rect: Rect) => Effect.Effect<StagedPageShot, WorkErrorBody>;
};

/** A shot main took of a box and staged, waiting for its comment to claim it. */
export type StagedPageShot = {
  /** Which bytes, as main stored them. */
  readonly ref: { readonly sha256: string; readonly byteLength: number };
  /** Whose stage holds them: the writer's own, or the claim is refused. */
  readonly stager: ContentStageSeat;
  /** The page's committed address when the shot was taken. */
  readonly url: string;
  readonly scroll: { readonly x: number; readonly y: number };
  /** The box in page CSS pixels, as main captured it. */
  readonly rect: Rect;
};

const runtimeDown = (message: string): WorkErrorBody => ({ type: "RuntimeDown", message, details: { retryable: true } });

/**
 * The node kind a subject's rows are held at. A file subject names a Files
 * node (`files`); its subject kind is `file`, which is the image card's word.
 */
const nodeKindOf = (kind: ResourceSubject["kind"]): NodeKind =>
  kind === "artifact" ? "artifacts" : kind === "file" ? "files" : kind;

/** The resource a subject names, whatever place on it. */
const withoutAnchor = (subject: ResourceSubject): ResourceSubject => {
  if (subject.kind === "task" || subject.anchor === undefined) return subject;
  const { anchor: _anchor, ...rest } = subject;
  return rest;
};

const posterNode = (actor: ResourceActor): NodeId | undefined => (actor.kind === "seat" ? asNodeId(actor.nodeId) : undefined);

const isBoxRect = Schema.is(BoxAnchor);

/** Let go of a shot whose comment was not written. */
const releaseShot = (owner: ContentOwner): Effect.Effect<void> =>
  Effect.serviceOption(ContentService).pipe(
    Effect.flatMap((content) => (Option.isNone(content) ? Effect.void : content.value.releaseOwner(owner).pipe(Effect.ignore))),
  );
const isPageBox = Schema.is(PageBoxAnchor);

/**
 * The staged shot held by the comment's own record: claimed from the
 * writer's own stage owner, so the record holds only bytes this writer
 * staged, and only once.
 */
const holdShot = (
  shot: StagedPageShot,
  stager: ContentStageSeat,
  owner: ContentOwner,
): Effect.Effect<{ readonly sha256: string; readonly byteLength: number }, WorkErrorBody> =>
  Effect.gen(function* () {
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return yield* Effect.fail(runtimeDown("the content store is not running in this process"));
    const staged = shot.stager.canvasName === stager.canvasName && shot.stager.nodeId === stager.nodeId;
    const claimed = staged
      ? yield* claimStagedContent(content.value, { ...stager, ref: shot.ref, owner }).pipe(Effect.option)
      : Option.none();
    if (Option.isNone(claimed)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: "That shot was already posted or dropped, or is not yours: draw the box again.",
        details: { path: "anchor", retryable: false },
      });
    }
    return { sha256: claimed.value.ref.sha256, byteLength: claimed.value.ref.byteLength };
  });

export const postSubjectComment = (
  input: SubjectCommentInput,
  context: SubjectCommentContext,
): Effect.Effect<SubjectCommented, WorkErrorBody> =>
  Effect.gen(function* () {
    const { canvas, canvasName } = context;
    const text = input.text.trim();
    if (text === "") {
      return yield* Effect.fail<WorkErrorBody>({ type: "InputError", message: "a comment's text must be non-empty", details: { path: "text", retryable: false } });
    }
    const nodeId = input.subject.nodeId;
    const node = canvas.nodes.get(nodeId);
    const expected = nodeKindOf(input.subject.kind);
    if (node === undefined || !isCommentableKind(node.kind) || node.kind !== expected) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `"${nodeId}" is not a ${expected} node on this canvas`,
        details: { path: "subject", target: nodeId, retryable: false },
      });
    }
    // A file subject names its file by the node and a path inside it, never by
    // an absolute path, and its anchor hangs on that same file.
    if (input.subject.kind === "file") {
      const anchor = input.anchor;
      if (!isRelativePath(input.subject.path)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "a file's path is relative to its node's root: no leading slash, no '..'",
          details: { path: "subject", retryable: false },
        });
      }
      if (anchor?.kind === "lines" && (anchor.file !== input.subject.path || anchor.side !== undefined)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "a file's lines anchor names the same path as its subject, and no diff side",
          details: { path: "anchor", retryable: false },
        });
      }
    }
    const poster = posterNode(input.actor);
    const from = input.actor.kind === "automation" ? input.actor.nodeId : poster;
    // A seat reaches a task as the task verbs do: a live overseer, every task node.
    const reached = from === undefined || (input.actor.kind === "seat" && node.kind === "task" ? seatReachesTaskNode(canvas, from, nodeId) : reaches(canvas, from, nodeId));
    if (!reached) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "ScopeError",
        message: `"${nodeId}" is outside the reach of "${from}"`,
        details: { reason: "not_in_reach", target: nodeId, retryable: false },
      });
    }
    // A mentioned seat must reach the resource: the composer offered only those.
    const inReach = new Set(seatsInReach(canvas, nodeId).map((seat) => seat.id as string));
    const mentioned = [...new Set(
      mentionsOf(text, (id) => canvas.nodes.get(id)?.kind).flatMap((at) => (at.ref.kind === "seat" ? [at.ref.nodeId] : [])),
    )];
    const outOfReach = mentioned.filter((seat) => !inReach.has(seat));
    if (outOfReach.length > 0) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "ScopeError",
        message: `${outOfReach.join(", ")} cannot be mentioned here: not in reach of "${nodeId}"`,
        details: { reason: "not_in_reach", path: "text", retryable: false },
      });
    }
    const mail = actorMailOf(canvas, canvasName, input.actor);
    if (mail === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: "an automation comments from its own node, never the operator's",
        details: { path: "actor", reason: "invalid_input", retryable: false },
      });
    }
    const machines = yield* Effect.serviceOption(MachineRepository);
    const work = yield* Effect.serviceOption(WorkService);
    if (Option.isNone(machines)) return yield* Effect.fail(runtimeDown("this machine's installation id is not running in this process"));
    if (Option.isNone(work)) return yield* Effect.fail(runtimeDown("the work service is not running in this process"));
    const installationId = yield* machines.value.installationId.pipe(Effect.mapError((error) => runtimeDown(String(error))));
    const asked = commentSubjectOf(input);
    const messageId = subjectCommentId(installationId, input);
    const threadId = commentThreadOf(input, messageId);

    // The thread so far, as the subject's node holds it. A reply takes the
    // thread's own subject, anchor and all; a thread on another resource is refused.
    const held = yield* work.value.readMailbox(canvasName, nodeId).pipe(Effect.mapError((error) => runtimeDown(error.message)));
    const thread = held.filter((row) => mailThreadOf(row) === threadId);
    const rooted = thread.map(threadSubjectOf).find((on) => on !== undefined);
    if (input.threadId !== undefined && input.subject.kind !== "task" && rooted === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `threadId "${input.threadId}" names no thread on ${subjectLabel(asked)}`,
        details: { path: "threadId", target: input.threadId, retryable: false },
      });
    }
    if (rooted !== undefined && !sameSubject(withoutAnchor(rooted), withoutAnchor(asked))) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: `thread "${threadId}" is on ${subjectLabel(rooted)}, not ${subjectLabel(asked)}`,
        details: { path: "threadId", retryable: false },
      });
    }
    // A page box: a new comment's shot, taken now; a reply copies its thread's.
    const boxAsked = input.subject.kind === "page" ? (input as Extract<SubjectCommentInput, { readonly subject: { readonly kind: "page" } }>).anchor : undefined;
    let pageBox: PageBoxAnchor | undefined;
    let shotOwner: ContentOwner | undefined;
    if (boxAsked !== undefined) {
      if (input.threadId !== undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "a reply copies its thread's box and takes no new shot: send no box",
          details: { path: "anchor", retryable: false },
        });
      }
      const box = { kind: "box" as const, x: boxAsked.x, y: boxAsked.y, w: boxAsked.w, h: boxAsked.h };
      if (!isBoxRect(box)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "a box is x, y, w and h in page pixels, its width and height above zero",
          details: { path: "anchor", retryable: false },
        });
      }
      const again = held.find((row) => row.messageId === messageId);
      const before = again === undefined ? undefined : threadSubjectOf(again);
      if (before?.kind === "page" && before.anchor !== undefined) {
        // The same write again: its row holds its shot already.
        pageBox = before.anchor;
      } else {
        if (context.pageShot === undefined || input.actor.kind === "automation") {
          return yield* Effect.fail<WorkErrorBody>({
            type: "ScopeError",
            message: "a box is drawn on the live page: only the operator, or a seat driving the page on this machine",
            details: { reason: "not_in_reach", path: "anchor", retryable: false },
          });
        }
        const shot = yield* context.pageShot(box);
        const stager = input.actor.kind === "operator"
          ? { canvasName, nodeId: operatorActorRef(canvasName).nodeId }
          : { canvasName, nodeId: input.actor.nodeId as string };
        shotOwner = { kind: "message", canvasName, nodeId, recordId: messageId };
        const ref = yield* holdShot(shot, stager, shotOwner);
        const url = pageBoxUrlOf(shot.url);
        // The box main captured, never the writer's request.
        const anchor = {
          kind: "box" as const,
          x: shot.rect.x,
          y: shot.rect.y,
          w: shot.rect.w,
          h: shot.rect.h,
          url,
          scroll: shot.scroll,
          shot: { sha256: ref.sha256, byteLength: ref.byteLength, mediaType: "image/png" },
        };
        if (url === undefined || !isPageBox(anchor)) {
          yield* releaseShot(shotOwner);
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "the page's address cannot be named on a comment: it must be http or https, and at most 2 KB without its query",
            details: { path: "anchor", retryable: false },
          });
        }
        pageBox = anchor;
      }
    }
    const subject = rooted ?? commentSubjectOf(input, pageBox);
    const earlier = thread.flatMap((row) => {
      const by = row.metadata?.senderNodeId;
      // A far live overseer that posted on a task is told of what follows, as any earlier poster.
      const told = typeof by === "string" &&
        (inReach.has(by) || (node.kind === "task" && canvas.nodes.get(asNodeId(by))?.kind === "agent" && seatReachesTaskNode(canvas, asNodeId(by), nodeId)));
      return told ? [asNodeId(by)] : [];
    });

    const metadata = {
      factoryMail: true,
      ...mailExtensionMetadata({ ...mail.stamp, mailKind: "notice" }),
      ...threadSubjectMetadata(subject),
      threadId,
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
    };
    const row = yield* work.value.workSubjectRow(
      canvasName,
      nodeId,
      makeUserMessage({ messageId, text, contextId: canvasName, metadata }),
      mail.sentBy,
    );
    if (!row.ok) {
      if (shotOwner !== undefined) yield* releaseShot(shotOwner);
      return yield* Effect.fail(runtimeDown(row.message));
    }
    // The comment stands: on a task or an artifact it is a change of it, so panes read again and change triggers wake.
    // A file's and a page's threads live in the node's mailbox: nothing of the resource itself changed,
    // so only the threads of that kind are said to have moved, and a rail reads again.
    if (input.subject.kind === "file") noteThreadChanged("file", canvasName);
    else if (input.subject.kind !== "page") noteResourceChanged(input.subject.kind, canvasName);

    // The comment stands, so each notice stands alone: a seat whose node is
    // gone is not told, and one notice that fails is logged while the rest
    // are still told. A retry under the same opId meets the told ones as
    // written (workSubjectNotice).
    const mentionedSet = new Set<string>(mentioned);
    const recipients = subjectNoticeRecipients([...mentioned, ...context.people, ...earlier], poster)
      .filter((recipient) => canvas.nodes.has(recipient));
    const notified: NodeId[] = [];
    for (const recipient of recipients) {
      const notice = subjectNoticeRow({
        kind: mentionedSet.has(recipient) ? "mention" : "comment",
        installationId,
        sourceId: messageId,
        subject,
        threadId: threadId as MailMessageId,
        recipient,
        text,
        sender: mail.stamp,
      });
      const told = yield* work.value.workSubjectNotice(
        canvasName,
        recipient,
        makeUserMessage({
          messageId: notice.messageId,
          text: notice.text,
          contextId: canvasName,
          metadata: { ...notice.metadata, ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }) },
        }),
        mail.sentBy,
      );
      if (told.ok) notified.push(recipient);
      else yield* Effect.logWarning("subject notice not written", { canvasName, recipient, comment: messageId, reason: told.message });
    }
    return { threadId, messageId, notified };
  });
