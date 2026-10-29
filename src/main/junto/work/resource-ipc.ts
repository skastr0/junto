// The renderer's tasks and artifacts over IPC (`resource-ipc.ts` in shared).
// Reads come from the task store and the ArtifactRepository through the same
// ports the CLI verbs use; a write is one ResourceCommand from the operator,
// submitted to the same ruler. There is no second write path: this file only
// builds the command and turns what the ruler made into an outcome.

import type { IpcMain } from "electron";
import { mailThreadOf, type MailMessageId } from "@shared/crew";
import { mailAuthorOf } from "@shared/mail-author";
import { operatorFilesOf } from "@shared/mail-threads";
import { messageIdTimeMs } from "@shared/message-delivery";
import { titleOf } from "@shared/model/title";
import { threadSubjectOf } from "@shared/thread-subject";
import type { Message } from "@shared/work-model";
import { productResourceKindEnabled } from "@shared/features";
import { Effect, Option, Result, Schema } from "effect";
import { decodeArtifactOp, type ArtifactBody, type ArtifactOp, type ArtifactVersion, type ArtifactVersionRecord } from "@shared/artifact";
import { artifactLabelOf, type ArtifactLabelColour, type ArtifactLabelColours } from "@shared/artifact-labels";
import type { Canvas } from "@shared/model";
import type { ContentRef } from "@shared/content";
import { operatorReachesResource } from "@shared/content-pull";
import type { OpOverlay } from "@shared/op-control";
import type { NodeId } from "@shared/physics/schema";
import { refusalError, type ResourceCommand } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import {
  ARTIFACT_HISTORY_PAGE,
  ArtifactApplyInput,
  ArtifactBodyInput,
  ArtifactHistoryInput,
  ArtifactMovesInput,
  ArtifactListInput,
  ArtifactPendingInput,
  ArtifactColourInput,
  ArtifactLabelColoursInput,
  RESOURCE_IPC_CHANNELS,
  TaskAllInput,
  TaskApplyInput,
  TaskContextInput,
  TaskListInput,
  TaskPendingInput,
  ThreadListInput,
  ThreadPostInput,
  taskCanvasFactsOf,
  type ResourceChanged,
  type SubjectThreadView,
  type ThreadChanged,
  type ThreadPost,
  type ThreadPostAuthor,
  type ThreadPostDraft,
  type ThreadPostOutcome,
  type ThreadResourceSubject,
  type ArtifactApplyOutcome,
  type ArtifactHead,
  type ResourceApplyOutcome,
  type ArtifactPendingWrite,
  type TaskApplyOutcome,
  type TaskCanvasFacts,
  type TaskPendingWrite,
} from "@shared/resource-ipc";
import { taskRefusalMessage } from "@shared/task-machine";
import {
  checkTaskCommand,
  seatNodeId,
  taskNodeId,
  TASK_STATES,
  TaskCommandWire,
  type TaskId,
  type TaskView,
} from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { commentOnArtifact, liveArtifactPorts, type ArtifactPorts } from "./artifact-control";
import { queuedOverlays, type QueuedOverlays } from "./op-control";
import { OpRepository } from "./op-repository";
import { onResourceChanged, onThreadChanged } from "./resource-changes";
import { postSubjectComment } from "./subject-comment";
import { commentOnTask, liveTaskPorts, taskCanvasEnv, taskRulingContext, type TaskPorts } from "./task-control";

/** What the handlers read and write through. Live: the CLI's own ports and the work topology. */
export type ResourceIpcPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
  readonly tasks: Pick<TaskPorts, "list" | "submit" | "find" | "comment">;
  readonly artifacts: Pick<ArtifactPorts, "list" | "head" | "body" | "history" | "moves" | "submit" | "pull" | "comment" | "labelColours" | "colourLabel">;
  /** The rows a node's mailbox holds: a task's or an artifact's comments are held at its node. */
  readonly mailbox: (canvasName: string, nodeId: NodeId) => Effect.Effect<ReadonlyArray<Message>, WorkErrorBody>;
  /** This machine's unruled queue with its overlays: `op list`'s own read (`queuedOverlays`). */
  readonly queue: (canvasName: string, canvas: Canvas) => Effect.Effect<QueuedOverlays | undefined, WorkErrorBody>;
};

const SCAN_LIMIT = 10_000;
const operator = { kind: "operator" } as const;

const commandOf = <Op>(
  canvasName: string,
  kind: "task" | "artifact",
  nodeId: NodeId,
  itemId: ItemId,
  opId: OpId,
  op: Op,
): ResourceCommand<Op> => ({
  opId,
  canvasName,
  actor: operator,
  target: { kind, nodeId, itemId },
  basis: null,
  after: [],
  op,
});

const byCreated = (a: TaskView, b: TaskView): number => a.createdAt - b.createdAt;

/**
 * The node a write names holds that domain's items: a task on a task node,
 * an artifact on an Artifacts node. The ruler's reach only asks that the
 * canvas holds the node.
 */
const targetRefusal = (canvas: Canvas, nodeId: NodeId, kind: "task" | "artifacts"): WorkErrorBody | undefined => {
  const node = canvas.nodes.get(nodeId);
  if (node === undefined) return refusalError({ reason: "unknown_target", message: `no node ${nodeId} on this canvas` });
  return node.kind === kind
    ? undefined
    : refusalError({ reason: "invalid_input", message: `${nodeId} is not ${kind === "task" ? "a task node" : "an Artifacts node"}` });
};

// ── tasks ──────────────────────────────────────────────────────────────────

/** The tasks on one node, archived ones too, oldest first. */
export const listTasks = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  ports.tasks
    .list(canvasName, { nodeIds: [taskNodeId(nodeId)], states: TASK_STATES, limit: SCAN_LIMIT })
    .pipe(Effect.map(({ tasks }) => [...tasks].sort(byCreated)));

/** Every task on the canvas's task nodes but archived ones, oldest first. */
export const allTasks = (ports: ResourceIpcPorts, canvasName: string) =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const nodeIds = [...canvas.nodes.values()].filter((node) => node.kind === "task").map((node) => taskNodeId(node.id));
    if (nodeIds.length === 0) return [];
    const { tasks } = yield* ports.tasks.list(canvasName, { nodeIds, limit: SCAN_LIMIT });
    return [...tasks].sort(byCreated);
  });

/** The ruler's view of the canvas as data: the same `taskCanvasEnv` a ruling reads. */
export const taskContext = (ports: ResourceIpcPorts, canvasName: string): Effect.Effect<TaskCanvasFacts, WorkErrorBody> =>
  Effect.map(ports.topology(canvasName), (canvas) => {
    const nodes = [...canvas.nodes.values()];
    return taskCanvasFactsOf(
      taskCanvasEnv(canvas),
      nodes.filter((node) => node.kind === "task").map((node) => taskNodeId(node.id)),
      nodes.filter((node) => node.kind === "agent").map((node) => seatNodeId(node.id)),
    );
  });

/**
 * One operator command, ruled as the CLI's are, with the mail it owes. The
 * target must be a task node, and the wire command is narrowed against the
 * canvas (`checkTaskCommand`): a seat it names is an agent and a next node a
 * task node, or it is refused.
 */
export const applyTask = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  taskId: TaskId,
  opId: OpId,
  wire: TaskCommandWire,
): Effect.Effect<TaskApplyOutcome> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const wrongTarget = targetRefusal(canvas, nodeId, "task");
    if (wrongTarget !== undefined) return { kind: "refused" as const, opId, error: wrongTarget };
    const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) {
      const { reason, detail } = checked.refusal;
      return { kind: "refused" as const, opId, error: refusalError({ reason, message: taskRefusalMessage(detail), expected: detail }) };
    }
    const command = commandOf(canvasName, "task", nodeId, taskId, opId, checked.command);
    const outcome = yield* ports.tasks.submit(command, taskRulingContext(canvas), taskCanvasEnv(canvas));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    // Queued for the machine that edits the canvas: `junto op show` reads what became of it.
    if (outcome.kind === "queued") return { kind: "queued" as const, opId };
    // The store port says it changed (resource-changes.ts), for every writer alike; the
    // mail the ruling owes was written with it, by each recipient's own machine.
    return { kind: "applied" as const, opId };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── artifacts ──────────────────────────────────────────────────────────────

/** The artifacts on one node, archived ones too, newest change first, each with its head body. */
/**
 * A body the window found pending: start pulling it from the machine that
 * edits the canvas. Every resource is in the operator's reach; the next read
 * finds it in the store. A list asks again for every head still pending, which
 * costs nothing: pullBody runs one transfer per object and joins the rest.
 */
const pullForOperator = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  artifactId: ItemId,
  version: ArtifactVersion,
  ref: ContentRef,
) =>
  ports.artifacts.pull({
    ref,
    reached: operatorReachesResource(canvasName, nodeId),
    owner: { kind: "artifact", canvasName, nodeId, recordId: `${artifactId}@${version}` },
  });

export const listArtifacts = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  Effect.gen(function* () {
    const lists = yield* Effect.forEach([false, true], (archived) =>
      ports.artifacts.list(canvasName, { nodeIds: [nodeId], archived, limit: SCAN_LIMIT }),
    );
    const items = lists.flatMap((list) => list.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    const heads = yield* Effect.forEach(items, (item) => ports.artifacts.head(canvasName, item.artifactId));
    for (const head of heads) {
      if (Option.isSome(head) && head.value.body === null) {
        const { artifact } = head.value;
        yield* pullForOperator(ports, canvasName, nodeId, artifact.artifactId, artifact.version, head.value.bodyRef);
      }
    }
    return heads.flatMap((head): ReadonlyArray<ArtifactHead> =>
      Option.isNone(head) ? [] : [{ artifact: head.value.artifact, body: head.value.body, bodyRef: head.value.bodyRef }],
    );
  });

/** The last page of versions, newest first, each with its body; a version whose body the store lacks is left out. */
/** Every move of an artifact, oldest first; none from a store that keeps no moves. */
export const artifactMoves = (ports: ResourceIpcPorts, canvasName: string, artifactId: ItemId) =>
  ports.artifacts.moves === undefined ? Effect.succeed([]) : ports.artifacts.moves(canvasName, artifactId);

export const artifactHistory = (ports: ResourceIpcPorts, canvasName: string, artifactId: ItemId) =>
  Effect.gen(function* () {
    const { versions } = yield* ports.artifacts.history(canvasName, artifactId, { limit: ARTIFACT_HISTORY_PAGE });
    const records = yield* Effect.forEach(versions, (version) =>
      Effect.map(ports.artifacts.body(canvasName, artifactId, version.version), (read) =>
        Option.isNone(read) || read.value.body === null
          ? []
          : [{ artifactId, version: version.version, author: version.author, at: version.at, body: read.value.body }],
      ),
    );
    return records.flat() as ReadonlyArray<ArtifactVersionRecord>;
  });

export const artifactBody = (
  ports: ResourceIpcPorts,
  canvasName: string,
  artifactId: ItemId,
  version: ArtifactVersion,
): Effect.Effect<ArtifactBody | null, WorkErrorBody> =>
  Effect.gen(function* () {
    const read = yield* ports.artifacts.body(canvasName, artifactId, version);
    if (Option.isNone(read)) return null;
    if (read.value.body === null) {
      const head = yield* ports.artifacts.head(canvasName, artifactId);
      if (Option.isSome(head)) yield* pullForOperator(ports, canvasName, head.value.artifact.nodeId, artifactId, version, read.value.bodyRef);
    }
    return read.value.body;
  });

export const applyArtifact = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  artifactId: ItemId,
  opId: OpId,
  op: ArtifactOp,
): Effect.Effect<ArtifactApplyOutcome> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    // A move goes to an Artifacts node too (0.11.1, 10).
    const wrongTarget = targetRefusal(canvas, nodeId, "artifacts") ?? (op.op === "move" ? targetRefusal(canvas, op.to, "artifacts") : undefined);
    if (wrongTarget !== undefined) return { kind: "refused" as const, opId, error: wrongTarget };
    const command = commandOf(canvasName, "artifact", nodeId, artifactId, opId, op);
    // The operator writes no automation, so no automation author is known.
    const outcome = yield* ports.artifacts.submit(command, rulingContextOf(canvas, () => undefined));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    // Queued for the machine that edits the canvas: `junto op show` reads what became of it.
    if (outcome.kind === "queued") return { kind: "queued" as const, opId };
    return { kind: "applied" as const, opId, facts: outcome.facts };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

const coloursOff: WorkErrorBody = {
  type: "InputError",
  message: "label colours are not held by this build yet",
  details: { reason: "not_available", retryable: false },
};

/** The label colours set in one Artifacts node (03 Colours); none when the store holds none. */
export const artifactLabelColours = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
): Effect.Effect<ArtifactLabelColours, WorkErrorBody> =>
  ports.artifacts.labelColours === undefined
    ? Effect.succeed(Object.create(null) as ArtifactLabelColours)
    : Effect.map(ports.artifacts.labelColours(canvasName, [nodeId]), (held) => held.get(nodeId) ?? (Object.create(null) as ArtifactLabelColours));

/**
 * A label's colour on an Artifacts node, as the operator: one
 * `{ op: "labelColour" }` on the node, no item. A label that breaks the rule
 * is refused here, as the ruler would refuse it.
 */
export const colourArtifactLabel = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  opId: OpId,
  label: string,
  colour: ArtifactLabelColour | null,
): Effect.Effect<ResourceApplyOutcome> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const wrongTarget = targetRefusal(canvas, nodeId, "artifacts");
    if (wrongTarget !== undefined) return { kind: "refused" as const, opId, error: wrongTarget };
    const folded = artifactLabelOf(label);
    if (folded === undefined) {
      return {
        kind: "refused" as const,
        opId,
        error: refusalError({ reason: "invalid_input", message: "a label is 1 to 40 characters of a-z 0-9 - _ / and space, no leading or trailing / or space, no //" }),
      };
    }
    if (ports.artifacts.colourLabel === undefined) return { kind: "refused" as const, opId, error: coloursOff };
    const outcome = yield* ports.artifacts.colourLabel(
      { opId, canvasName, actor: operator, nodeId, label: folded, colour },
      rulingContextOf(canvas, () => undefined),
    );
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    return { kind: outcome.kind, opId };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── threads ────────────────────────────────────────────────────────────────

const onSubject = (subject: ThreadResourceSubject) => (row: Message): boolean => {
  const on = threadSubjectOf(row);
  if (on === undefined) return false;
  // An artifact is its id wherever it sits: a comment written before a move still names the node it was on.
  if (subject.kind === "artifact") return on.kind === "artifact" && on.artifactId === subject.artifactId;
  if (on.nodeId !== subject.nodeId) return false;
  switch (subject.kind) {
    case "task":
      return on.kind === "task" && on.taskId === subject.taskId;
    case "file":
      return on.kind === "file" && on.path === subject.path;
  }
};

const stamp = (row: Message, key: string): string | undefined => {
  const value = row.metadata?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Who wrote a comment row, by its stamp, named as the canvas names them now; a notice or a malformed stamp is no post. */
const authorOf = (canvas: Canvas, row: Message): ThreadPostAuthor | undefined => {
  const seatId = stamp(row, "fromSeat");
  const nodeId = stamp(row, "senderNodeId");
  if (seatId === undefined || nodeId === undefined) return undefined;
  const author = mailAuthorOf({ seatId: seatId as never, nodeId });
  const name = (id: string) => {
    const node = canvas.nodes.get(id as NodeId);
    return node === undefined ? (stamp(row, "senderName") ?? id) : titleOf(node);
  };
  switch (author.kind) {
    case "operator":
      return { kind: "operator", name: "operator" };
    case "seat":
      return { kind: "seat", seatId: author.seatId, nodeId: author.nodeId as NodeId, name: name(author.nodeId) };
    case "automation":
      return { kind: "automation", nodeId: author.nodeId as unknown as NodeId, name: name(author.nodeId) };
    default:
      return undefined;
  }
};

const postOf = (canvas: Canvas, row: Message): ThreadPost | undefined => {
  const author = authorOf(canvas, row);
  if (author === undefined) return undefined;
  const files = operatorFilesOf(row);
  return {
    postId: row.messageId as MailMessageId,
    author,
    text: row.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n").trim(),
    at: messageIdTimeMs(row.messageId) ?? 0,
    ...(files.length === 0 ? {} : { attachments: files }),
  };
};

const byAge = (a: ThreadPost, b: ThreadPost): number => a.at - b.at || (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0);

const productOff = (kind: ThreadResourceSubject["kind"]): WorkErrorBody => ({
  type: "InputError",
  message: `${kind === "task" ? "tasks are" : kind === "artifact" ? "artifacts are" : "files are"} not in this Junto build`,
  details: { reason: "not_available", retryable: false },
});

/**
 * The threads on a task or an artifact, from its node's mailbox: rows on
 * this subject, grouped by thread, each oldest post first, threads by their
 * first post. The operator reads every resource.
 */
/**
 * Where a subject's comments are held: its node's mailbox, and for an
 * artifact that has moved, every node it has been on too (0.11.1, 10), so a
 * move leaves no comment behind. New comments go to where it is now.
 */
const mailboxesOf = (
  ports: ResourceIpcPorts,
  canvasName: string,
  subject: ThreadResourceSubject,
): Effect.Effect<ReadonlyArray<NodeId>, WorkErrorBody> =>
  subject.kind !== "artifact" || ports.artifacts.moves === undefined
    ? Effect.succeed([subject.nodeId])
    : Effect.map(ports.artifacts.moves(canvasName, subject.artifactId), (moves) => [
        ...new Set([subject.nodeId, ...moves.flatMap((move) => [move.from, move.to])]),
      ]);

export const listThreads = (
  ports: ResourceIpcPorts,
  canvasName: string,
  subject: ThreadResourceSubject,
): Effect.Effect<ReadonlyArray<SubjectThreadView>, WorkErrorBody> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const rows = (yield* Effect.forEach(yield* mailboxesOf(ports, canvasName, subject), (nodeId) => ports.mailbox(canvasName, nodeId)))
      .flat()
      .filter(onSubject(subject));
    const threads = new Map<string, { anchor?: SubjectThreadView["anchor"]; posts: ThreadPost[] }>();
    for (const row of rows) {
      const post = postOf(canvas, row);
      if (post === undefined) continue;
      const threadId = mailThreadOf(row);
      const thread = threads.get(threadId) ?? { posts: [] };
      // The root names the thread's place; a reply copies it.
      const on = threadSubjectOf(row);
      if ((on?.kind === "artifact" || on?.kind === "file") && on.anchor !== undefined && (thread.anchor === undefined || row.messageId === threadId)) {
        thread.anchor = on.anchor;
      }
      thread.posts.push(post);
      threads.set(threadId, thread);
    }
    return [...threads]
      .map(([threadId, thread]): SubjectThreadView => ({
        threadId: threadId as MailMessageId,
        ...(thread.anchor === undefined ? {} : { anchor: thread.anchor }),
        posts: [...thread.posts].sort(byAge),
      }))
      .sort((a, b) => byAge(a.posts[0]!, b.posts[0]!));
  });

/**
 * The operator's post on a task or an artifact, through the CLI's own comment
 * path for its kind: mentions become links or stay plain text, and the
 * resource's people are told. A comment is written here at once, never
 * queued; a replayed opId is the same row, answered as it first was.
 */
export const postThread = (
  ports: ResourceIpcPorts,
  canvasName: string,
  subject: ThreadResourceSubject,
  post: ThreadPostDraft,
): Effect.Effect<ThreadPostOutcome> =>
  Effect.gen(function* () {
    const commenter = { canvas: yield* ports.topology(canvasName), canvasName, actor: operator };
    if (subject.kind === "task") {
      if (post.anchor !== undefined) {
        return yield* Effect.fail<WorkErrorBody>({ type: "InputError", message: "a task comment takes no anchor", details: { path: "anchor", retryable: false } });
      }
      // A task has one thread, its own.
      if (post.threadId !== undefined && post.threadId !== (subject.taskId as string)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `a task's thread is the task: ${subject.taskId}`,
          details: { path: "threadId", retryable: false },
        });
      }
      const sent = yield* commentOnTask(commenter, ports.tasks, { opId: post.opId, task: subject.taskId, text: post.text, node: subject.nodeId });
      return { kind: "applied" as const, opId: post.opId, threadId: sent.threadId as MailMessageId, postId: sent.messageId as MailMessageId, notified: sent.notified as ReadonlyArray<NodeId> };
    }
    if (subject.kind === "file") {
      const anchor = post.anchor;
      if (anchor !== undefined && anchor.kind !== "lines" && anchor.kind !== "pageBox") {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "a file comment hangs on its lines, or on a box on one of its pages",
          details: { path: "anchor", retryable: false },
        });
      }
      // A file's lines are the file's own: the anchor names the subject's path.
      if (anchor?.kind === "lines" && (anchor.file !== subject.path || anchor.side !== undefined)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `a lines anchor on a file names its path, ${subject.path}, and no diff side`,
          details: { path: "anchor", retryable: false },
        });
      }
      const sent = yield* postSubjectComment(
        {
          text: post.text,
          actor: operator,
          opId: post.opId,
          subject: { kind: "file", nodeId: subject.nodeId, path: subject.path },
          ...(anchor === undefined ? {} : { anchor }),
          ...(post.threadId === undefined ? {} : { threadId: post.threadId }),
        },
        // A file's people are none of its own: mentions and earlier posters are told by the write path.
        { canvas: commenter.canvas, canvasName, people: [] },
      );
      return { kind: "applied" as const, opId: post.opId, threadId: sent.threadId, postId: sent.messageId, notified: sent.notified };
    }
    const sent = yield* commentOnArtifact(commenter, ports.artifacts, {
      opId: post.opId,
      artifact: subject.artifactId,
      text: post.text,
      node: subject.nodeId,
      ...(post.anchor === undefined ? {} : { anchor: post.anchor }),
      ...(post.threadId === undefined ? {} : { threadId: post.threadId }),
    });
    return { kind: "applied" as const, opId: post.opId, threadId: sent.threadId as MailMessageId, postId: sent.messageId as MailMessageId, notified: sent.notified as ReadonlyArray<NodeId> };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId: post.opId, error })));

// ── registration ───────────────────────────────────────────────────────────

/** Runs a handler in the app runtime, which holds the stores. */
export type ResourceIpcRun = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const decodeTaskCommand = Schema.decodeUnknownResult(TaskCommandWire);

/** The node's unruled writes of one domain, in queue order, each with its overlay when it has one. */
const pendingOn = <W extends object>(
  ports: ResourceIpcPorts,
  canvasName: string,
  kind: "task" | "artifact",
  nodeId: NodeId,
  write: (opId: OpId, itemId: ItemId, op: unknown) => W | undefined,
): Effect.Effect<ReadonlyArray<W & { readonly overlay?: OpOverlay }>, WorkErrorBody> =>
  Effect.gen(function* () {
    const queued = yield* ports.queue(canvasName, yield* ports.topology(canvasName));
    if (queued === undefined) return [];
    return queued.commands.flatMap(({ opId, target, op }) => {
      if (target.kind !== kind || target.nodeId !== nodeId || target.itemId === undefined) return [];
      const pending = write(opId, target.itemId, op);
      if (pending === undefined) return [];
      const overlay = queued.overlays.get(opId);
      return [overlay === undefined ? pending : { ...pending, overlay }];
    });
  });

export const pendingArtifacts = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  pendingOn(ports, canvasName, "artifact", nodeId, (opId, artifactId, op): ArtifactPendingWrite | undefined => {
    const decoded = decodeArtifactOp(op);
    return Result.isSuccess(decoded) ? { opId, artifactId, op: decoded.success } : undefined;
  });

export const pendingTasks = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  pendingOn(ports, canvasName, "task", nodeId, (opId, taskId, op): TaskPendingWrite | undefined => {
    const decoded = decodeTaskCommand(op);
    return Result.isSuccess(decoded) ? { opId, taskId, command: decoded.success } : undefined;
  });

/**
 * The running core's ports: the CLI verbs' own, and the canvas and a node's
 * mailbox as ipc.ts reads them from the work plane (this file reaches no
 * WorkService).
 */
export const liveResourceIpcPorts = (
  topology: ResourceIpcPorts["topology"],
  mailbox: ResourceIpcPorts["mailbox"],
): ResourceIpcPorts => ({
  topology,
  mailbox,
  tasks: liveTaskPorts,
  artifacts: liveArtifactPorts,
  // A build without the record of resource writes queues nothing: no write waits.
  queue: (canvasName, canvas) =>
    Effect.flatMap(Effect.serviceOption(OpRepository), (repository) =>
      Option.isNone(repository)
        ? Effect.succeed(undefined)
        : queuedOverlays(canvasName, canvas).pipe(Effect.provideService(OpRepository, repository.value))),
});

const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input, { onExcessProperty: "error" }) as Effect.Effect<S["Type"], Schema.SchemaError>;

/** A read that fails rejects with the store's own message. */
const asError = (error: WorkErrorBody | Schema.SchemaError): Error => new Error(error.message);

/** A write under its main authoring label (`runMainAuthoring` in ipc.ts), so shutdown drains it. */
export type ResourceAuthoring = <A>(operation: () => Promise<A>) => Promise<A>;

/**
 * The handlers on their channels, each domain behind its feature. Every
 * payload is decoded strictly. A write runs under its authoring label and
 * answers refused rather than rejecting, except when the app is closing.
 * Every applied write, whoever made it, is told to the windows as
 * `<domain>-changed`. Returns the unsubscribe from those notices.
 */
export const registerResourceIpc = (
  ipc: Pick<IpcMain, "handle">,
  run: ResourceIpcRun,
  ports: ResourceIpcPorts,
  broadcast: (channel: string, payload: ResourceChanged | ThreadChanged) => void,
  enabled: { readonly task: boolean; readonly artifact: boolean; readonly file: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring; readonly thread: ResourceAuthoring },
): (() => void) => {
  const on = <S extends Schema.Top, A>(
    channel: string,
    schema: S,
    handle: (input: S["Type"]) => Effect.Effect<A, WorkErrorBody>,
    authored?: ResourceAuthoring,
  ) =>
    ipc.handle(channel, (_event, input: unknown) => {
      const operation = () => run(Effect.flatMap(decoded(schema, input), handle).pipe(Effect.mapError(asError)));
      return authored === undefined ? operation() : authored(operation);
    });
  // A product this build turns off registers nothing, whatever the caller asks.
  const live = {
    task: enabled.task && productResourceKindEnabled("task"),
    artifact: enabled.artifact && productResourceKindEnabled("artifact"),
    file: enabled.file,
  };
  const task = RESOURCE_IPC_CHANNELS.task;
  if (live.task) {
    on(task.list, TaskListInput, (input) => listTasks(ports, input.canvasName, input.nodeId));
    on(task.all, TaskAllInput, (input) => allTasks(ports, input.canvasName));
    on(task.context, TaskContextInput, (input) => taskContext(ports, input.canvasName));
    on(task.apply, TaskApplyInput, (input) =>
      applyTask(ports, input.canvasName, input.nodeId, input.taskId, input.opId, input.command), authoring.task);
    on(task.pending, TaskPendingInput, (input) => pendingTasks(ports, input.canvasName, input.nodeId));
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (live.artifact) {
    on(artifact.list, ArtifactListInput, (input) => listArtifacts(ports, input.canvasName, input.nodeId));
    on(artifact.history, ArtifactHistoryInput, (input) => artifactHistory(ports, input.canvasName, input.artifactId));
    on(artifact.moves, ArtifactMovesInput, (input) => artifactMoves(ports, input.canvasName, input.artifactId));
    on(artifact.body, ArtifactBodyInput, (input) => artifactBody(ports, input.canvasName, input.artifactId, input.version));
    on(artifact.apply, ArtifactApplyInput, (input) =>
      applyArtifact(ports, input.canvasName, input.nodeId, input.artifactId, input.opId, input.op), authoring.artifact);
    on(artifact.pending, ArtifactPendingInput, (input) => pendingArtifacts(ports, input.canvasName, input.nodeId));
    on(artifact.labelColours, ArtifactLabelColoursInput, (input) => artifactLabelColours(ports, input.canvasName, input.nodeId));
    on(artifact.colour, ArtifactColourInput, (input) =>
      colourArtifactLabel(ports, input.canvasName, input.nodeId, input.opId, input.label, input.colour), authoring.artifact);
  }
  // Threads on any of the kinds, each kind behind its own product.
  const thread = RESOURCE_IPC_CHANNELS.thread;
  if (live.task || live.artifact || live.file) {
    on(thread.list, ThreadListInput, (input) =>
      live[input.subject.kind] ? listThreads(ports, input.canvasName, input.subject) : Effect.fail(productOff(input.subject.kind)));
    on(thread.post, ThreadPostInput, (input) =>
      live[input.subject.kind]
        ? postThread(ports, input.canvasName, input.subject, input.post)
        : Effect.succeed({ kind: "refused" as const, opId: input.post.opId, error: productOff(input.subject.kind) }), authoring.thread);
  }
  const offDomain = onResourceChanged((domain, canvasName) => {
    if (!live[domain]) return;
    broadcast(RESOURCE_IPC_CHANNELS[domain].changed, { canvasName });
    broadcast(thread.changed, { canvasName, kind: domain } satisfies ThreadChanged);
  });
  // A comment on a page or a file changes nothing of the resource, so only the
  // threads of that kind are said to have moved: the rail reads again.
  const offThread = onThreadChanged((kind, canvasName) => {
    if (!live[kind]) return;
    broadcast(thread.changed, { canvasName, kind } satisfies ThreadChanged);
  });
  return () => {
    offDomain();
    offThread();
  };
};
