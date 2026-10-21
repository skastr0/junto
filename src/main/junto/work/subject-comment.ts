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
 */
import { Effect, Option } from "effect";
import type { MailMessageId } from "@shared/crew";
import { mentionsOf } from "@shared/mention";
import type { Canvas } from "@shared/model";
import { asNodeId } from "@shared/model";
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
import { sameSubject, subjectLabel, threadSubjectMetadata, threadSubjectOf, type ResourceSubject } from "@shared/thread-subject";
import type { WorkErrorBody } from "@shared/work-control";
import { mailExtensionMetadata, mailThreadOf } from "@shared/crew";
import { MachineRepository } from "../machines/repository";
import { actorMailOf } from "./actor-mail";
import { noteResourceChanged } from "./resource-changes";
import { WorkService } from "./service";

/** What the caller knows of the resource beside the comment. */
export type SubjectCommentContext = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  /** The resource's people: a task's assignee and seat reviewers, an artifact's author. */
  readonly people: ReadonlyArray<NodeId>;
};

const runtimeDown = (message: string): WorkErrorBody => ({ type: "RuntimeDown", message, details: { retryable: true } });

/** The resource a subject names, whatever place on it. */
const withoutAnchor = (subject: ResourceSubject): ResourceSubject => {
  if (subject.kind === "task" || subject.anchor === undefined) return subject;
  const { anchor: _anchor, ...rest } = subject;
  return rest;
};

const posterNode = (actor: ResourceActor): NodeId | undefined => (actor.kind === "seat" ? asNodeId(actor.nodeId) : undefined);

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
    if (node === undefined || !isCommentableKind(node.kind) || node.kind !== (input.subject.kind === "artifact" ? "artifacts" : input.subject.kind)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `"${nodeId}" is not a ${input.subject.kind === "artifact" ? "artifacts" : input.subject.kind} node on this canvas`,
        details: { path: "subject", target: nodeId, retryable: false },
      });
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
    const subject = rooted ?? asked;
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
    if (!row.ok) return yield* Effect.fail(runtimeDown(row.message));
    // The comment stands: on a task or an artifact it is a change of it, so panes read again and change triggers wake.
    if (input.subject.kind !== "page") noteResourceChanged(input.subject.kind, canvasName);

    const mentionedSet = new Set<string>(mentioned);
    const recipients = subjectNoticeRecipients([...mentioned, ...context.people, ...earlier], poster);
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
      if (!told.ok) return yield* Effect.fail(runtimeDown(told.message));
    }
    return { threadId, messageId, notified: recipients };
  });
