// `junto artifact` in main (plan 05, cli L3): decode each verb, find the
// Artifacts node or the artifact in the seat's reach, build the body or the
// edit for the artifact's type, and hand each write to the local ruler as a
// ResourceCommand (02). Storage reaches this file through `ArtifactPorts`, so
// the verbs are tested without a database and the store can move under them.

import { noteResourceChanged } from "./resource-changes";
import { Effect, Option, Result, Schema } from "effect";
import {
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactOp,
  type ArtifactType,
  type ArtifactVersion,
  admitsAnchor,
  artifactText,
  decodeArtifactBody,
  decodeArtifactEdit,
  emptyBody,
} from "@shared/artifact";
import {
  ArtifactCommentArgs,
  ArtifactCreateArgs,
  ArtifactEditArgs,
  ArtifactHistoryArgs,
  ArtifactListArgs,
  ArtifactOneArgs,
  ArtifactShowArgs,
  type ArtifactControlOp,
  type ArtifactHistoryResult,
  type ArtifactListResult,
  type ArtifactShowResult,
  type ArtifactCommentResult,
  type ArtifactWriteResult,
  type BodyInput,
} from "@shared/artifact-control";
import type { MailMessageId } from "@shared/crew";
import { parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches } from "@shared/region-reach";
import type { ResourceActor, ResourceCommand, RulingContext } from "@shared/resource-command";
import type { ContentRef } from "@shared/content";
import { type ResourceReached, operatorReachesResource, seatReachesResource } from "@shared/content-pull";
import type { SubjectCommentInput, SubjectCommented } from "@shared/subject-comment";
import { subjectAnchorOf } from "@shared/thread-subject";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { operatorActorRef } from "@shared/work-reference";
import { ArtifactFact } from "@shared/artifact-domain";
import type { QueuedCommand } from "@shared/command-row";
import { ResourceSubmit } from "./resource-submit";
import { localQueue, queuedArtifactCommands } from "./queued-commands";
import type {
  ArtifactHeadRead,
  ArtifactListQuery,
  ArtifactSubmitOutcome,
  ArtifactVersionRead,
} from "./artifact-repository";
import { BodyPuller } from "../content/body-puller";
import type { PulledOwner } from "../content/pull";
import { ArtifactRepository, type ArtifactBodyRead } from "./artifact-repository";
import { TaskRepository } from "./task-repository";
import { productDisabledError } from "./authz";
import { linkMentionsAt } from "./mention-links";
import { ARTIFACTS_ENABLED } from "@shared/features";
import { postSubjectComment, type SubjectCommentContext } from "./subject-comment";

/** What the verbs need from the artifact store and the ruler. */
export type ArtifactPorts = {
  /** The canvas's Artifacts nodes. */
  readonly nodes: (canvas: Canvas) => ReadonlyArray<Node>;
  readonly list: (canvasName: string, query: ArtifactListQuery) => Effect.Effect<Omit<ArtifactListResult, "artifacts"> & { readonly artifacts: ArtifactListResult["artifacts"] }, WorkErrorBody>;
  readonly head: (canvasName: string, artifactId: ItemId) => Effect.Effect<Option.Option<ArtifactHeadRead>, WorkErrorBody>;
  /** One version's body and its ref; the body is null while its bytes are pending. */
  readonly body: (canvasName: string, artifactId: ItemId, version: ArtifactVersion) => Effect.Effect<Option.Option<ArtifactBodyRead>, WorkErrorBody>;
  /**
   * Start bringing a pending body here from the machine that edits its canvas,
   * and return at once. One pull per object; on the editing machine, none.
   */
  readonly pull: (input: { readonly ref: ContentRef; readonly owner: PulledOwner; readonly reached: ResourceReached }) => Effect.Effect<void>;
  readonly history: (
    canvasName: string,
    artifactId: ItemId,
    page: { readonly limit: number; readonly before?: ArtifactVersion },
  ) => Effect.Effect<{ readonly versions: ReadonlyArray<ArtifactVersionRead>; readonly more: boolean }, WorkErrorBody>;
  /** Rule a command here when this machine edits the canvas; otherwise queue it for the machine that does. */
  readonly submit: (command: ResourceCommand<ArtifactOp>, context: RulingContext) => Effect.Effect<ArtifactWriteOutcome, WorkErrorBody>;
  /** Post a comment on a resource: the one write path for comments (03). */
  readonly comment: (input: SubjectCommentInput, context: SubjectCommentContext) => Effect.Effect<SubjectCommented, WorkErrorBody>;
  /** The task node a task sits on, when the task exists. */
  readonly taskNode: (canvasName: string, taskId: ItemId) => Effect.Effect<Option.Option<NodeId>, WorkErrorBody>;
};

export type ArtifactCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

/** Who comments: a seat the work socket admitted, or the operator from a window, who reaches every artifact. */
export type ArtifactCommenter = Omit<ArtifactCaller, "actor"> & {
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" | "operator" }>;
};

const LIST_DEFAULT_LIMIT = 50;
const HISTORY_DEFAULT_LIMIT = 20;

const artifactNodes = (canvas: Canvas): ReadonlyArray<Node> =>
  [...canvas.nodes.values()].filter((node) => node.kind === "artifacts");

const storeError = (error: { readonly message: string }): WorkErrorBody => ({
  type: "InternalError",
  message: error.message,
  details: { retryable: true },
});

const notBuilt: WorkErrorBody = {
  type: "InputError",
  message: "the artifact store is not running in this process",
  details: { reason: "not_available", retryable: false },
};

/** What an artifact write came to: ruled here or there, or queued for the editing machine (02). */
export type ArtifactWriteOutcome = ArtifactSubmitOutcome | { readonly kind: "queued"; readonly opId: OpId };

const decodeArtifactFacts = Schema.decodeUnknownResult(Schema.Array(ArtifactFact), { onExcessProperty: "error" });

/**
 * A command queued for the editing machine, as the seat's write answers it.
 * An applied ruling that came back was folded here before it was read, so the
 * head this machine holds is the version it made.
 */
const queuedOutcome = (
  repo: ArtifactRepository["Service"],
  submit: ResourceSubmit["Service"],
  command: ResourceCommand<ArtifactOp>,
  editor: Parameters<ResourceSubmit["Service"]["queue"]>[1],
): Effect.Effect<ArtifactWriteOutcome, WorkErrorBody> =>
  Effect.flatMap(
    // The wire form of an artifact op is the op itself.
    submit.queue(command as QueuedCommand, editor),
    (outcome): Effect.Effect<ArtifactWriteOutcome, WorkErrorBody> => {
      switch (outcome.kind) {
        case "queued":
          return Effect.succeed({ kind: "queued", opId: command.opId });
        case "refused":
          return Effect.succeed({ kind: "refused", opId: command.opId, error: outcome.error, root: outcome.root });
        case "applied": {
          const facts = decodeArtifactFacts(outcome.ruling.facts);
          const artifactId = command.target.itemId;
          if (Result.isFailure(facts) || artifactId === undefined) {
            return Effect.fail(storeError({ message: `the ruling of ${command.opId} names no artifact this build reads` }));
          }
          return repo.head(command.canvasName, artifactId).pipe(
            Effect.mapError(storeError),
            Effect.flatMap((head) =>
              Option.isNone(head)
                ? Effect.fail(storeError({ message: `the artifact ruled by ${command.opId} is not held here` }))
                : Effect.succeed({ kind: "applied" as const, opId: command.opId, artifactId, version: head.value.artifact.version, facts: facts.success })),
          );
        }
      }
    },
  );

/** Every port through the ArtifactRepository in the running core. */
export const liveArtifactPorts: ArtifactPorts = (() => {
  const withRepo = <A>(use: (repo: ArtifactRepository["Service"]) => Effect.Effect<A, { readonly message: string }>) =>
    Effect.serviceOption(ArtifactRepository).pipe(
      Effect.flatMap((repo) => (Option.isNone(repo) ? Effect.fail(notBuilt) : use(repo.value).pipe(Effect.mapError(storeError)))),
    ) as Effect.Effect<A, WorkErrorBody>;
  return {
    nodes: artifactNodes,
    list: (canvasName, query) => withRepo((repo) => repo.list(canvasName, query)),
    head: (canvasName, id) => withRepo((repo) => repo.head(canvasName, id)),
    body: (canvasName, id, version) => withRepo((repo) => repo.body(canvasName, id, version)),
    history: (canvasName, id, page) => withRepo((repo) => repo.history(canvasName, id, page)),
    submit: (command, context) =>
      withRepo((repo) =>
        Effect.gen(function* () {
          const remote = yield* Effect.serviceOption(ResourceSubmit);
          if (Option.isSome(remote)) {
            const route = yield* remote.value.route(command.canvasName).pipe(Effect.mapError((error) => ({ message: error.message })));
            if (route.kind === "editor") {
              // Refused at once when the ruled artifacts held here and this writer's queue already refuse it for good: answered to the caller only.
              const queue = yield* localQueue(command.canvasName);
              const refused = queue === undefined
                ? Option.none()
                : yield* repo.precheck(queue.writer, queuedArtifactCommands(queue.commands), command, context);
              if (Option.isSome(refused)) return refused.value;
              return yield* queuedOutcome(repo, remote.value, command, route.editor).pipe(Effect.mapError((error) => ({ message: error.message })));
            }
          }
          const writer = yield* repo.localWriter();
          if (Option.isNone(writer)) return yield* Effect.fail({ message: "this machine has no installation id yet" });
          return yield* repo.submit(writer.value, command, context);
        }),
      ).pipe(
        // A resend answered from the stored ruling made nothing.
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.kind === "applied" && outcome.facts.length > 0) noteResourceChanged("artifact", command.canvasName);
          })),
      ),
    comment: postSubjectComment,
    pull: (input) =>
      Effect.serviceOption(BodyPuller).pipe(
        Effect.flatMap((puller) =>
          Option.isNone(puller) ? Effect.void : puller.value.pull(input).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid),
        ),
      ),
    taskNode: (canvasName, taskId) =>
      Effect.serviceOption(TaskRepository).pipe(
        Effect.flatMap((tasks) =>
          Option.isNone(tasks)
            ? Effect.succeed(Option.none<NodeId>())
            : tasks.value.get(canvasName, taskId).pipe(
                Effect.map(Option.map((task) => task.current.node as unknown as NodeId)),
                Effect.mapError(storeError),
              ),
        ),
      ),
  };
})();

const decode = <S extends Schema.Top>(schema: S, args: unknown): Effect.Effect<S["Type"], WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args ?? {});
  return Result.isFailure(decoded)
    ? Effect.fail({
        type: "InputError",
        message: String((decoded.failure as { readonly message?: unknown }).message ?? decoded.failure),
        details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
      })
    : Effect.succeed(decoded.success as S["Type"]);
};

const inputError = (message: string, path: string, hint?: string): WorkErrorBody => ({
  type: "InputError",
  message,
  details: { path, retryable: false, ...(hint === undefined ? {} : { hint }) },
});

const namesOf = (names: ReadonlyArray<string>): string => names.slice(0, 12).join(", ");

const inReach = (caller: ArtifactCommenter, nodeId: NodeId): boolean =>
  caller.actor.kind === "operator" || reaches(caller.canvas, caller.actor.nodeId, nodeId);

/**
 * The Artifacts node a list or create names, or the one in reach when it
 * names none. Only nodes in reach are matched or named in a hint, so a seat
 * learns nothing of Artifacts nodes it cannot reach.
 */
const findNode = (
  caller: ArtifactCaller,
  ports: ArtifactPorts,
  text: string | undefined,
): Effect.Effect<Node, WorkErrorBody> => {
  const reached = ports.nodes(caller.canvas).filter((node) => inReach(caller, node.id));
  const hint = reached.length === 0 ? "no Artifacts node is in this seat's reach" : `Artifacts nodes in reach: ${namesOf(reached.map(titleOf))}`;
  if (text === undefined) {
    if (reached.length === 1) return Effect.succeed(reached[0]!);
    return Effect.fail(
      reached.length === 0
        ? { type: "UnknownTarget", message: "no Artifacts node is in this seat's reach", details: { path: "node", retryable: false } }
        : inputError(`${reached.length} Artifacts nodes are in reach; name one with --node`, "node", hint),
    );
  }
  const link = text.startsWith("junto://") ? parseMentionHref(text) : undefined;
  const named = link !== undefined
    ? reached.filter((node) => node.id === link.nodeId && link.item === undefined)
    : reached.filter((node) => node.id === text || titleOf(node) === text);
  if (named.length === 1) return Effect.succeed(named[0]!);
  return Effect.fail(
    named.length === 0
      ? {
          type: "UnknownTarget",
          message: `no Artifacts node ${text} in this seat's reach`,
          details: { path: "node", received: text, retryable: false, hint },
        }
      : inputError(`${named.length} Artifacts nodes in reach are named ${text}; name one by its id`, "node", hint),
  );
};

/**
 * A version whose bytes are not here yet: start pulling them from the machine
 * that edits the canvas, on this seat's reach, and answer pending now. The
 * next read resolves from the content store once they arrive.
 */
const awaitPull = (
  caller: ArtifactCommenter,
  ports: Pick<ArtifactPorts, "pull">,
  nodeId: NodeId,
  artifactId: ItemId,
  version: ArtifactVersion,
  ref: ContentRef,
): Effect.Effect<never, WorkErrorBody> =>
  Effect.gen(function* () {
    const reached = caller.actor.kind === "operator"
      ? operatorReachesResource(caller.canvasName, nodeId)
      : seatReachesResource(caller.canvasName, caller.canvas, caller.actor.nodeId, nodeId);
    if (reached !== undefined) {
      yield* ports.pull({ ref, reached, owner: { kind: "artifact", canvasName: caller.canvasName, nodeId, recordId: `${artifactId}@${version}` } });
    }
    return yield* Effect.fail<WorkErrorBody>({
      type: "InputError",
      message: `the body of artifact ${artifactId} at version ${version} is still on its way to this machine`,
      details: { reason: "not_available", retryable: true, hint: "try again in a moment" },
    });
  });

/**
 * The head of an artifact in reach. One out of reach reads as unknown, so a
 * seat learns nothing of artifacts it cannot reach.
 */
const findArtifact = (
  caller: ArtifactCommenter,
  ports: Pick<ArtifactPorts, "head">,
  artifactId: ItemId,
): Effect.Effect<ArtifactHeadRead, WorkErrorBody> =>
  Effect.flatMap(ports.head(caller.canvasName, artifactId), (head) =>
    Option.isSome(head) && inReach(caller, head.value.artifact.nodeId)
      ? Effect.succeed(head.value)
      : Effect.fail<WorkErrorBody>({
          type: "UnknownTarget",
          message: `no artifact ${artifactId} in this seat's reach`,
          details: { path: "artifact", received: artifactId, retryable: false, hint: "junto artifact list shows the artifacts in reach" },
        }),
  );

/**
 * The body a seat wrote, for an artifact of `type`: markdown for a document,
 * a url for a link, or any body as JSON with its type filled in.
 */
export const bodyFor = (type: ArtifactType, input: BodyInput, path: string): Result.Result<ArtifactBody, WorkErrorBody> => {
  let candidate: unknown;
  if ("markdown" in input) {
    if (type !== "document") return Result.fail(inputError(`--markdown is a document's body; this is a ${type}`, path));
    candidate = { type: "document", markdown: input.markdown };
  } else if ("url" in input) {
    if (type !== "link") return Result.fail(inputError(`--url is a link's body; this is a ${type}`, path));
    candidate = { type: "link", target: { kind: "url", url: input.url } };
  } else {
    if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) {
      return Result.fail(inputError("a body is a JSON object", path));
    }
    const given = (input.body as { readonly type?: unknown }).type;
    if (given !== undefined && given !== type) {
      return Result.fail(inputError(`the body is a ${String(given)}; this is a ${type}`, path));
    }
    candidate = { ...input.body, type };
  }
  const decoded = decodeArtifactBody(candidate);
  return Result.isFailure(decoded)
    ? Result.fail(inputError(`not a ${type} body: ${String(decoded.failure)}`, path, `junto schema show artifact.create`))
    : Result.succeed(decoded.success);
};

/** A create's body: the one given, or a fresh one for the types that start empty. */
const createBody = (type: ArtifactType, input: BodyInput | undefined): Result.Result<ArtifactBody, WorkErrorBody> => {
  if (input !== undefined) return bodyFor(type, input, "body");
  switch (type) {
    case "document":
    case "pad":
    case "sheet":
      return Result.succeed(emptyBody(type));
    case "link":
      return Result.fail(inputError("a link needs its address", "body", "--url <https://...>"));
    case "file":
      return Result.fail(inputError("a file needs its content ref", "body", "--body '{\"content\":{...}}'"));
  }
};

/** An edit: the whole body replaced, or patches for a pad, sheet or document. */
const editFor = (
  head: ArtifactHeadRead,
  input: typeof ArtifactEditArgs.Type,
): Result.Result<ArtifactEdit, WorkErrorBody> => {
  const type = head.artifact.type;
  if ((input.body === undefined) === (input.patches === undefined)) {
    return Result.fail(inputError("an edit carries a body or patches, one of them", "body", "--body to replace, --patch to patch"));
  }
  if (input.body !== undefined) {
    const body = bodyFor(type, input.body, "body");
    return Result.map(body, (replacement) => ({ kind: "replace", baseVersion: input.baseVersion, body: replacement }));
  }
  if (type === "link" || type === "file") {
    return Result.fail(inputError(`a ${type} is replaced whole, never patched`, "patches", "--body to replace it"));
  }
  const decoded = decodeArtifactEdit({ kind: "patch", type, baseVersion: input.baseVersion, patches: input.patches });
  return Result.isFailure(decoded)
    ? Result.fail(inputError(`not ${type} patches: ${String(decoded.failure)}`, "patches"))
    : Result.succeed(decoded.success);
};

const command = (
  caller: ArtifactCaller,
  opId: OpId,
  nodeId: NodeId,
  artifactId: ItemId,
  op: ArtifactOp,
): ResourceCommand<ArtifactOp> => ({
  opId,
  canvasName: caller.canvasName,
  actor: caller.actor,
  target: { kind: "artifact", nodeId, itemId: artifactId },
  basis: null,
  // Off the editing machine, ResourceSubmit adds the unruled commands this one builds on.
  after: [],
  op,
});

/** The ruler checks reach again at ruling time, against the canvas it rules on. */
const rulingContext = (caller: ArtifactCaller): RulingContext => ({
  inReach: (actor, target) => {
    switch (actor.kind) {
      case "seat":
        return reaches(caller.canvas, actor.nodeId, target.nodeId);
      case "operator":
        return true;
      // An automation reaches nothing until plan 07 gives it a reach.
      case "automation":
        return false;
    }
  },
});

/**
 * Every task a create links must sit on a task node in the seat's reach; one
 * out of reach reads as unknown, like a missing one, so the link names
 * nothing the seat cannot see.
 */
const checkTasks = (
  caller: ArtifactCaller,
  ports: ArtifactPorts,
  taskIds: ReadonlyArray<ItemId>,
): Effect.Effect<void, WorkErrorBody> =>
  Effect.forEach(taskIds, (taskId, index) =>
    Effect.flatMap(ports.taskNode(caller.canvasName, taskId), (node) =>
      Option.isSome(node) && inReach(caller, node.value)
        ? Effect.void
        : Effect.fail<WorkErrorBody>({
            type: "UnknownTarget",
            message: `no task ${taskId} in this seat's reach`,
            details: { path: `taskIds[${index}]`, received: taskId, retryable: false },
          }),
    ), { discard: true });

/** An applied ruling as the CLI's result; a refusal as its error, carrying the opId. */
export const writeResult = (
  outcome: ArtifactWriteOutcome,
  written: Pick<ResourceCommand<ArtifactOp>, "target">,
): Effect.Effect<ArtifactWriteResult, WorkErrorBody> => {
  switch (outcome.kind) {
    case "applied":
      return Effect.succeed({ disposition: "applied", opId: outcome.opId, artifactId: outcome.artifactId, version: outcome.version });
    case "refused":
      return Effect.fail({ ...outcome.error, details: { ...outcome.error.details, opId: outcome.opId } });
    // Durable and will be ruled: a success. `junto op show` reads what became of it.
    case "queued":
      return Effect.succeed({ disposition: "queued", opId: outcome.opId, artifactId: written.target.itemId! });
  }
};

const submit = (caller: ArtifactCaller, ports: ArtifactPorts, write: ResourceCommand<ArtifactOp>) =>
  Effect.flatMap(ports.submit(write, rulingContext(caller)), (outcome) => writeResult(outcome, write));

/** One artifact verb, for a seat the work socket admitted. */
export const handleArtifactOp = (
  op: ArtifactControlOp,
  args: unknown,
  caller: ArtifactCaller,
  ports: ArtifactPorts,
): Effect.Effect<unknown, WorkErrorBody> =>
  Effect.gen(function* () {
    if (!ARTIFACTS_ENABLED) return yield* Effect.fail(productDisabledError(caller.actor.nodeId, "artifacts", op));
    switch (op) {
      case "artifact.list": {
        const input = yield* decode(ArtifactListArgs, args);
        const nodeIds = input.node === undefined
          ? ports.nodes(caller.canvas).filter((node) => inReach(caller, node.id)).map((node) => node.id)
          : [(yield* findNode(caller, ports, input.node)).id];
        const found = yield* ports.list(caller.canvasName, {
          nodeIds,
          archived: input.archived ?? false,
          limit: input.limit ?? LIST_DEFAULT_LIMIT,
          ...(input.type === undefined ? {} : { type: input.type }),
        });
        return {
          artifacts: found.artifacts.map(({ artifactId, nodeId, type, title, version, updatedAt, archived }) => ({
            artifactId, nodeId, type, title, version, updatedAt, archived,
          })),
          more: found.more,
        } satisfies ArtifactListResult;
      }
      case "artifact.show": {
        const input = yield* decode(ArtifactShowArgs, args);
        const head = yield* findArtifact(caller, ports, input.artifact);
        const version = input.version ?? head.artifact.version;
        const read = version === head.artifact.version
          ? head
          : Option.getOrUndefined(yield* ports.body(caller.canvasName, input.artifact, version));
        if (read === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "UnknownTarget",
            message: `artifact ${input.artifact} has no version ${version}; the head is ${head.artifact.version}`,
            details: { path: "version", expected: head.artifact.version, retryable: false },
          });
        }
        const body = read.body;
        if (body === null) return yield* awaitPull(caller, ports, head.artifact.nodeId, input.artifact, version, read.bodyRef);
        return { artifact: head.artifact, version, text: artifactText(body), body } satisfies ArtifactShowResult;
      }
      case "artifact.history": {
        const input = yield* decode(ArtifactHistoryArgs, args);
        yield* findArtifact(caller, ports, input.artifact);
        const page = yield* ports.history(caller.canvasName, input.artifact, {
          limit: input.limit ?? HISTORY_DEFAULT_LIMIT,
          ...(input.before === undefined ? {} : { before: input.before }),
        });
        return {
          artifactId: input.artifact,
          versions: page.versions.map((entry) => ({
            version: entry.version,
            author: entry.author,
            at: entry.at,
            change: entry.edit === undefined ? "create" : entry.edit === "unrecorded" ? entry.edit : entry.edit.kind,
          })),
          more: page.more,
        } satisfies ArtifactHistoryResult;
      }
      case "artifact.create": {
        const input = yield* decode(ArtifactCreateArgs, args);
        const node = yield* findNode(caller, ports, input.node);
        const body = createBody(input.type, input.body);
        if (Result.isFailure(body)) return yield* Effect.fail(body.failure);
        if (input.taskIds !== undefined) yield* checkTasks(caller, ports, input.taskIds);
        return yield* submit(caller, ports, command(caller, input.opId, node.id, input.artifactId, {
          op: "create",
          title: input.title,
          body: body.success,
          ...(input.taskIds === undefined ? {} : { taskIds: input.taskIds }),
        }));
      }
      case "artifact.edit": {
        const input = yield* decode(ArtifactEditArgs, args);
        const head = yield* findArtifact(caller, ports, input.artifact);
        const edit = editFor(head, input);
        if (Result.isFailure(edit)) return yield* Effect.fail(edit.failure);
        return yield* submit(caller, ports, command(caller, input.opId, head.artifact.nodeId, input.artifact, {
          op: "edit",
          edit: edit.success,
        }));
      }
      case "artifact.archive":
      case "artifact.restore": {
        const input = yield* decode(ArtifactOneArgs, args);
        const head = yield* findArtifact(caller, ports, input.artifact);
        return yield* submit(caller, ports, command(caller, input.opId, head.artifact.nodeId, input.artifact, {
          op: op === "artifact.archive" ? "archive" : "restore",
        }));
      }
      case "artifact.comment":
        return yield* commentOnArtifact(caller, ports, yield* decode(ArtifactCommentArgs, args));
    }
  });

/**
 * A comment on an artifact, by a seat (`junto artifact comment`) or by the
 * operator (the window's thread rail): one path, so the two never disagree.
 * The anchor is checked against the artifact's type, a pending body is pulled
 * first, each @name becomes its mention link, and the artifact's author is
 * told. `threadId` replies in a thread on the artifact.
 */
export const commentOnArtifact = (
  caller: ArtifactCommenter,
  ports: Pick<ArtifactPorts, "head" | "pull" | "comment">,
  input: ArtifactCommentArgs & { readonly threadId?: MailMessageId; readonly node?: NodeId },
): Effect.Effect<ArtifactCommentResult, WorkErrorBody> =>
  Effect.gen(function* () {
    const head = yield* findArtifact(caller, ports, input.artifact);
    // A window names the Artifacts node it shows: an artifact on another is not there.
    if (input.node !== undefined && head.artifact.nodeId !== input.node) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `no artifact ${input.artifact} on node ${input.node}`,
        details: { path: "artifact", received: input.artifact, retryable: false },
      });
    }
    if (input.anchor !== undefined && head.body === null) {
      return yield* awaitPull(caller, ports, head.artifact.nodeId, input.artifact, head.artifact.version, head.bodyRef);
    }
    if (input.anchor !== undefined && head.body !== null && !admitsAnchor(head.body, input.anchor)) {
      return yield* Effect.fail(
        inputError(
          `a ${head.artifact.type} does not take a ${input.anchor.kind} anchor here`,
          "anchor",
          head.artifact.type === "sheet" ? "a cells anchor is an A1 range, like B2 or A1:C4" : undefined,
        ),
      );
    }
    // `whole` is no anchor. The wire Anchor still spells lines, which no
    // artifact takes, so the check narrows it to an artifact's place.
    const anchor = input.anchor === undefined ? undefined : subjectAnchorOf(input.anchor);
    if (anchor?.kind === "lines") {
      return yield* Effect.fail(inputError(`a ${head.artifact.type} does not take a lines anchor`, "anchor"));
    }
    // Each mention becomes its link: in reach of the artifact, whoever writes (03).
    const callerId = caller.actor.kind === "seat" ? caller.actor.nodeId : operatorActorRef(caller.canvasName).nodeId;
    const text = yield* linkMentionsAt(caller.canvas, caller.canvasName, callerId, input.text, { kind: "comments", nodeId: head.artifact.nodeId }).pipe(
      Effect.mapError((error): WorkErrorBody => ({ ...error, details: { ...error.details, opId: input.opId } })),
    );
    const author = head.artifact.createdBy;
    const posted = yield* ports
      .comment(
        {
          subject: { kind: "artifact", nodeId: head.artifact.nodeId, artifactId: input.artifact },
          ...(anchor === undefined ? {} : { anchor }),
          text,
          actor: caller.actor,
          opId: input.opId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        },
        { canvas: caller.canvas, canvasName: caller.canvasName, people: author.kind === "seat" ? [author.nodeId] : [] },
      )
      .pipe(Effect.mapError((error) => ({ ...error, details: { ...error.details, opId: input.opId } })));
    return {
      disposition: "applied",
      opId: input.opId,
      threadId: posted.threadId,
      messageId: posted.messageId,
      notified: posted.notified,
    } satisfies ArtifactCommentResult;
  });
