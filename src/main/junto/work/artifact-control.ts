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
  ANCHOR_KINDS,
  admitsAnchor,
  artifactText,
  decodeArtifactBody,
  decodeArtifactEdit,
  emptyBody,
} from "@shared/artifact";
import {
  ArtifactColourArgs,
  ArtifactCommentArgs,
  ArtifactCreateArgs,
  ArtifactEditArgs,
  ArtifactHistoryArgs,
  ArtifactLabelArgs,
  ArtifactListArgs,
  ArtifactOneArgs,
  ArtifactShowArgs,
  type ArtifactControlOp,
  type ArtifactHistoryResult,
  type ArtifactListResult,
  type ArtifactShowResult,
  type ArtifactLinkedFrom,
  ARTIFACT_LINKED_FROM_MAX,
  type ArtifactColourResult,
  type ArtifactCommentResult,
  type ArtifactWriteResult,
  type BodyInput,
} from "@shared/artifact-control";
import type { MailMessageId } from "@shared/crew";
import { mentionKey, parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches } from "@shared/region-reach";
import type { ResourceActor, ResourceCommand, RulingContext } from "@shared/resource-command";
import { pendingUnknownOf, withPendingMark, type PendingMarks } from "@shared/op-control";
import type { ContentRef } from "@shared/content";
import { type ResourceReached, operatorReachesResource, seatReachesResource } from "@shared/content-pull";
import type { SubjectCommentInput, SubjectCommented } from "@shared/subject-comment";
import { subjectAnchorOf } from "@shared/thread-subject";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { operatorActorRef } from "@shared/work-reference";
import { ArtifactFact } from "@shared/artifact-domain";
import {
  type ArtifactLabel,
  type ArtifactLabelColour,
  type ArtifactLabelColours,
  artifactLabelOf,
  artifactLabelsOf,
  foldArtifactLabels,
  notALabel,
} from "@shared/artifact-labels";
import type { QueuedCommand } from "@shared/command-row";
import { ResourceSubmit } from "./resource-submit";
import { localQueue, precheckInput, queuedArtifactCommands } from "./queued-commands";
import type {
  ArtifactHeadRead,
  ArtifactListQuery,
  ArtifactMoveRead,
  ArtifactSubmitOutcome,
  ArtifactVersionRead,
} from "./artifact-repository";
import { BodyPuller } from "../content/body-puller";
import type { PulledOwner } from "../content/pull";
import { ArtifactRepository, type ArtifactBodyRead } from "./artifact-repository";
import { TaskRepository } from "./task-repository";
import { productDisabledError } from "./authz";
import { linkMentionsAt, unlinkedField } from "./mention-links";
import { ARTIFACTS_ENABLED } from "@shared/features";
import { postSubjectComment, type SubjectCommentContext } from "./subject-comment";
import { bodyTexts, editTexts, hasArtifactLinkTokens, linkBodyTitles, linkEditTitles, type ResolveTitle } from "@shared/artifact-link-tokens";
import { resolveArtifactTitles } from "./artifact-link-titles";
import { readMentions, type MentionRow } from "./mention-backlinks";
import { entryOf } from "./mention-ipc";
import { linkedFromBodies } from "./body-links";
import type { ArtifactLinkRef, LinkedFromBody } from "@shared/artifact-links";
import { SqlClient } from "effect/unstable/sql";

/** What the verbs need from the artifact store and the ruler. */
export type ArtifactPorts = {
  /** The canvas's Artifacts nodes. */
  readonly nodes: (canvas: Canvas) => ReadonlyArray<Node>;
  readonly list: (canvasName: string, query: ArtifactListQuery) => Effect.Effect<Omit<ArtifactListResult, "artifacts"> & { readonly artifacts: ArtifactListResult["artifacts"] }, WorkErrorBody>;
  readonly head: (canvasName: string, artifactId: ItemId) => Effect.Effect<Option.Option<ArtifactHeadRead>, WorkErrorBody>;
  /**
   * The mark of each item this machine's queued writes touch (`pendingMarksOf`):
   * list and show carry it. Absent, nothing is marked.
   */
  readonly pending?: (canvasName: string, canvas: Canvas) => Effect.Effect<PendingMarks>;
  /** One version's body and its ref; the body is null while its bytes are pending. */
  readonly body: (canvasName: string, artifactId: ItemId, version: ArtifactVersion) => Effect.Effect<Option.Option<ArtifactBodyRead>, WorkErrorBody>;
  /**
   * Start bringing a pending body here from the machine that edits its canvas,
   * and return at once. One pull per object; on the editing machine, none.
   */
  readonly pull: (input: { readonly ref: ContentRef; readonly owner: PulledOwner; readonly reached: ResourceReached }) => Effect.Effect<void>;
  /** Every move of an artifact, oldest first (0.11.1, 10). Absent: a store that keeps none, so nothing has moved. */
  readonly moves?: (canvasName: string, artifactId: ItemId) => Effect.Effect<ReadonlyArray<ArtifactMoveRead>, WorkErrorBody>;
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
  /** Up to `limit` mail rows that mention `key`, newest first (`work_mentions`). Absent, show lists none. */
  readonly mentions?: (canvasName: string, key: string, limit: number) => Effect.Effect<ReadonlyArray<MentionRow>, WorkErrorBody>;
  /**
   * The set this machine's last unruled `labels` write for the artifact sends,
   * when one is queued for the editing machine (03). `--add` and `--remove`
   * build on it, not on the ruled head, so a seat's second change keeps its
   * first. Absent, the head is read.
   */
  readonly queuedLabels?: (canvasName: string, artifactId: ItemId) => Effect.Effect<Option.Option<ReadonlyArray<string>>>;
  /** The label colours set in each Artifacts node asked for (03, Colours). Absent, list and show name none. */
  readonly labelColours?: (canvasName: string, nodeIds: ReadonlyArray<NodeId>) => Effect.Effect<ReadonlyMap<NodeId, ArtifactLabelColours>, WorkErrorBody>;
  /**
   * Rule `{ op: "labelColour" }` on an Artifacts node, here or queued for the
   * editing machine, as `submit` does for an artifact. Absent, the verb
   * answers not available.
   */
  readonly colourLabel?: (write: LabelColourWrite, context: RulingContext) => Effect.Effect<LabelColourOutcome, WorkErrorBody>;
  /** The artifacts whose head body links `target`, newest first, archived ones left out (L1). Absent, show lists none. */
  readonly bodyLinks?: (canvas: Canvas, canvasName: string, target: ArtifactLinkRef) => Effect.Effect<ReadonlyArray<LinkedFromBody>, WorkErrorBody>;
};

/** A colour write on an Artifacts node: the label folded, `colour: null` unsets it. */
export type LabelColourWrite = {
  readonly opId: OpId;
  readonly canvasName: string;
  /** A seat, or the operator writing from a window (resource IPC). */
  readonly actor: ArtifactCommenter["actor"];
  readonly nodeId: NodeId;
  readonly label: ArtifactLabel;
  readonly colour: ArtifactLabelColour | null;
};

export type LabelColourOutcome =
  | { readonly kind: "applied" | "queued"; readonly opId: OpId }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody };

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

const noMarks: PendingMarks = new Map();
/** What list and show mark pending (`ArtifactPorts.pending`). */
const pendingOf = (caller: Pick<ArtifactCaller, "canvas" | "canvasName">, ports: Pick<ArtifactPorts, "pending">) =>
  ports.pending === undefined ? Effect.succeed(noMarks) : ports.pending(caller.canvasName, caller.canvas);
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
    moves: (canvasName, id) => withRepo((repo) => repo.moves(canvasName, id)),
    submit: (command, context) =>
      withRepo((repo) =>
        Effect.gen(function* () {
          const remote = yield* Effect.serviceOption(ResourceSubmit);
          if (Option.isSome(remote)) {
            const route = yield* remote.value.route(command.canvasName).pipe(Effect.mapError((error) => ({ message: error.message })));
            if (route.kind === "editor") {
              // Refused at once when the ruled artifacts held here and this writer's queue already refuse it for good: answered to the caller only.
              const input = yield* precheckInput(command, queuedArtifactCommands);
              const refused = input === undefined
                ? Option.none()
                : yield* repo.precheck(input.writer, input.queued, input.command, input.refused, context);
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
            if (outcome.kind === "applied" && outcome.facts.length > 0) noteResourceChanged("artifact", command.canvasName, { command });
          })),
      ),
    labelColours: (canvasName, nodeIds) => withRepo((repo) => repo.labelColours(canvasName, nodeIds)),
    colourLabel: (write, context) => {
      // On the node itself, no item: the ruler sends it to submitNode (C1).
      const command: ResourceCommand<ArtifactOp> = {
        opId: write.opId,
        canvasName: write.canvasName,
        actor: write.actor,
        target: { kind: "artifact", nodeId: write.nodeId },
        basis: null,
        after: [],
        op: { op: "labelColour", label: write.label, colour: write.colour },
      };
      return withRepo((repo) =>
        Effect.gen(function* () {
          const remote = yield* Effect.serviceOption(ResourceSubmit);
          if (Option.isSome(remote)) {
            const route = yield* remote.value.route(command.canvasName).pipe(Effect.mapError((error) => ({ message: error.message })));
            if (route.kind === "editor") {
              const queued = yield* remote.value.queue(command as QueuedCommand, route.editor).pipe(Effect.mapError((error) => ({ message: error.message })));
              // An applied ruling names the node, not a head: there is nothing to read back.
              switch (queued.kind) {
                case "queued":
                  return { kind: "queued" as const, opId: command.opId, changed: false };
                case "refused":
                  return { kind: "refused" as const, opId: command.opId, error: queued.error };
                case "applied":
                  return { kind: "applied" as const, opId: command.opId, changed: queued.ruling.facts.length > 0 };
              }
            }
          }
          const writer = yield* repo.localWriter();
          if (Option.isNone(writer)) return yield* Effect.fail({ message: "this machine has no installation id yet" });
          const ruled = yield* repo.submitNode(writer.value, command, context);
          return ruled.kind === "applied"
            ? { kind: "applied" as const, opId: ruled.opId, changed: ruled.facts.length > 0 }
            : { kind: "refused" as const, opId: ruled.opId, error: ruled.error };
        }),
      ).pipe(
        // A resend answered from the stored ruling made nothing.
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.kind === "applied" && outcome.changed) noteResourceChanged("artifact", command.canvasName, { command });
          })),
        Effect.map((outcome): LabelColourOutcome => (outcome.kind === "refused" ? outcome : { kind: outcome.kind, opId: outcome.opId })),
      );
    },
    comment: postSubjectComment,
    queuedLabels: (canvasName, artifactId) =>
      Effect.map(localQueue(canvasName), (queue) => {
        const queued = queuedArtifactCommands(queue?.commands ?? []).flatMap((command) =>
          command.target.itemId === artifactId && command.op.op === "labels" ? [command.op.labels] : []);
        return Option.fromNullishOr(queued.at(-1));
      }),
    pull: (input) =>
      Effect.serviceOption(BodyPuller).pipe(
        Effect.flatMap((puller) =>
          Option.isNone(puller) ? Effect.void : puller.value.pull(input).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid),
        ),
      ),
    bodyLinks: (canvas, canvasName, target) =>
      Effect.serviceOption(SqlClient.SqlClient).pipe(
        Effect.flatMap((sql) =>
          Option.isNone(sql) ? Effect.succeed([]) : linkedFromBodies(sql.value, canvas, canvasName, target).pipe(Effect.mapError(storeError)),
        ),
      ),
    mentions: (canvasName, key, limit) =>
      Effect.serviceOption(SqlClient.SqlClient).pipe(
        Effect.flatMap((sql) =>
          Option.isNone(sql) ? Effect.succeed([]) : readMentions(sql.value, canvasName, key, limit).pipe(Effect.mapError(storeError)),
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

/**
 * Labels as a seat typed them, folded (03): trimmed, lowered, unique and
 * sorted. The first that cannot be a label is refused by name, at the flag
 * that carried it, so nothing reaches the ruler that it would refuse.
 */
const foldLabels = (raw: ReadonlyArray<string>, path: string): Effect.Effect<ReadonlyArray<ArtifactLabel>, WorkErrorBody> => {
  const folded = foldArtifactLabels(raw);
  if (folded.ok) return Effect.succeed(folded.labels);
  if (folded.index === undefined) return Effect.fail(inputError(folded.message, path));
  return Effect.fail({
    type: "InputError",
    message: folded.message,
    details: { path: `${path}[${folded.index}]`, received: raw[folded.index], retryable: false },
  });
};

/**
 * The set a label write sends: `set` whole, or the held set with `add`
 * joined and `remove` taken out. Removing a label not held changes nothing,
 * and a label both added and removed ends removed.
 */
const nextLabels = (
  held: ReadonlyArray<ArtifactLabel>,
  input: ArtifactLabelArgs,
): Effect.Effect<ReadonlyArray<ArtifactLabel>, WorkErrorBody> =>
  Effect.gen(function* () {
    const changes = input.add !== undefined || input.remove !== undefined;
    if ((input.set !== undefined) === changes) {
      return yield* Effect.fail(inputError("name the whole set, or labels to add and remove, one of them", "set", "--set a,b, or --add a --remove b"));
    }
    if (input.set !== undefined) return yield* foldLabels(input.set, "set");
    const added = yield* foldLabels(input.add ?? [], "add");
    const removed = new Set(yield* foldLabels(input.remove ?? [], "remove"));
    const next = [...held, ...added].filter((label) => !removed.has(label));
    return yield* foldLabels(next, "add");
  });

/** The colours of the `labels` an artifact carries that have one in its node; undefined when none do. */
const coloursOf = (
  colours: ReadonlyMap<NodeId, ArtifactLabelColours>,
  nodeId: NodeId,
  labels: ReadonlyArray<ArtifactLabel>,
): ArtifactLabelColours | undefined => {
  const set = colours.get(nodeId);
  if (set === undefined) return undefined;
  // Own keys only: `constructor` and `__proto__` are labels too.
  const held = labels.flatMap((label) => (Object.hasOwn(set, label) ? [[label, set[label]!] as const] : []));
  return held.length === 0 ? undefined : Object.fromEntries(held);
};

const noColours: ReadonlyMap<NodeId, ArtifactLabelColours> = new Map();
const labelColoursOf = (caller: Pick<ArtifactCaller, "canvasName">, ports: Pick<ArtifactPorts, "labelColours">, nodeIds: ReadonlyArray<NodeId>) =>
  ports.labelColours === undefined || nodeIds.length === 0 ? Effect.succeed(noColours) : ports.labelColours(caller.canvasName, nodeIds);

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

/**
 * An edit with its `[[Title]]` tokens linked. A document's patches are read
 * against the body at the edit's base, pulled first when its bytes are not
 * here, so each link splice lands where the seat's splices put the token.
 */
const linkEdit = (
  caller: ArtifactCaller,
  ports: ArtifactPorts,
  head: ArtifactHeadRead,
  edit: ArtifactEdit,
  resolve: ResolveTitle<WorkErrorBody>,
): Effect.Effect<ArtifactEdit, WorkErrorBody> =>
  Effect.gen(function* () {
    let base: ArtifactBody | null = null;
    if (edit.kind === "patch" && edit.type === "document") {
      const read = edit.baseVersion === head.artifact.version
        ? head
        : Option.getOrUndefined(yield* ports.body(caller.canvasName, head.artifact.artifactId, edit.baseVersion));
      // A base that is gone: the ruler refuses the edit as stale, links or not.
      if (read !== undefined && read.body === null) {
        return yield* awaitPull(caller, ports, head.artifact.nodeId, head.artifact.artifactId, edit.baseVersion, read.bodyRef);
      }
      base = read?.body ?? null;
    }
    const linked = linkEditTitles(edit, base, resolve);
    if (Result.isSuccess(linked)) return linked.success;
    const refused = linked.failure;
    return yield* Effect.fail("kind" in refused
      ? inputError(`linking its [[ ]] titles takes this edit past ${refused.max} patches`, "patches", "send the edit in two, or replace the body whole")
      : refused);
  });

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

/** Rows read before the seat's own filter, so a page of the ones it may read is usually whole. */
const LINKED_FROM_SCAN = 200;

/**
 * Where an artifact is linked from, as `junto artifact show` lists it: the
 * bodies of artifacts in the seat's reach that link it, and mail and comments
 * that mention it, kept to what this seat may read. Its own mailbox, mail it
 * wrote, and threads held at nodes in its reach; never another seat's mail.
 */
const linkedFromOf = (
  caller: ArtifactCaller,
  ports: ArtifactPorts,
  artifact: { readonly nodeId: NodeId; readonly artifactId: ItemId },
): Effect.Effect<ArtifactLinkedFrom, WorkErrorBody> =>
  Effect.gen(function* () {
    const seat = caller.actor.nodeId;
    const linking = ports.bodyLinks === undefined ? [] : yield* ports.bodyLinks(caller.canvas, caller.canvasName, { nodeId: artifact.nodeId, artifactId: artifact.artifactId });
    const bodies = linking.filter((link) => reaches(caller.canvas, seat, link.source.nodeId));
    // A mention written before a move names a node the artifact was on: each of those still mentions it (0.11.1, 10).
    const moves = ports.moves === undefined ? [] : yield* ports.moves(caller.canvasName, artifact.artifactId);
    const nodes = [...new Set([artifact.nodeId, ...moves.map((move) => move.from)])];
    const scans = ports.mentions === undefined
      ? []
      : yield* Effect.forEach(nodes, (nodeId) =>
          ports.mentions!(caller.canvasName, mentionKey({ kind: "artifact", nodeId, artifactId: artifact.artifactId }), LINKED_FROM_SCAN));
    const rows = scans.flat();
    const readable = rows.flatMap((row) => {
      const entry = entryOf(caller.canvas, row);
      if (entry === undefined) return [];
      const own = entry.mailbox === seat || (entry.author.kind === "seat" && entry.author.nodeId === seat);
      // A thread is held at its own resource, never in a seat's mailbox: pinned
      // here, not left to the writers, since reach also joins seats in a region.
      // A thread on this artifact is read where the artifact is now, not where it was written.
      const onThis = entry.subject?.kind === "artifact" && entry.subject.artifactId === artifact.artifactId;
      const thread = entry.subject !== undefined &&
        entry.subject.nodeId === entry.mailbox &&
        caller.canvas.nodes.get(entry.mailbox)?.kind !== "agent" &&
        reaches(caller.canvas, seat, onThis ? artifact.nodeId : entry.mailbox);
      return own || thread ? [entry] : [];
    });
    return {
      bodies: bodies.slice(0, ARTIFACT_LINKED_FROM_MAX),
      mail: readable.slice(0, ARTIFACT_LINKED_FROM_MAX),
      more: bodies.length > ARTIFACT_LINKED_FROM_MAX || readable.length > ARTIFACT_LINKED_FROM_MAX || scans.some((scan) => scan.length === LINKED_FROM_SCAN),
    };
  });

/** As many artifacts as a `[[Title]]` is matched among: every head in reach, in practice. */
const TITLE_SCAN_LIMIT = 10_000;

/**
 * What each `[[Title]]` in a write links to (plan 0.11, 02, L5): the artifacts
 * on Artifacts nodes in the seat's reach, archived ones left out. Read only
 * when the write carries a token; undefined when it carries none.
 */
const titleResolver = (
  caller: ArtifactCaller,
  ports: ArtifactPorts,
  texts: ReadonlyArray<string>,
): Effect.Effect<ResolveTitle<WorkErrorBody> | undefined, WorkErrorBody> =>
  Effect.gen(function* () {
    if (!hasArtifactLinkTokens(texts)) return undefined;
    const nodeIds = ports.nodes(caller.canvas).filter((node) => inReach(caller, node.id)).map((node) => node.id);
    const found = nodeIds.length === 0
      ? []
      : (yield* ports.list(caller.canvasName, { nodeIds, archived: false, limit: TITLE_SCAN_LIMIT })).artifacts;
    return resolveArtifactTitles(
      found.map(({ artifactId, nodeId, title }) => ({ artifactId, nodeId, title })),
      caller.canvasName,
      "body",
    );
  });

const withOpId = (opId: OpId) => (error: WorkErrorBody): WorkErrorBody => ({ ...error, details: { ...error.details, opId } });

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
        const labels = input.labels === undefined ? undefined : yield* foldLabels(input.labels, "labels");
        const found = yield* ports.list(caller.canvasName, {
          nodeIds,
          archived: input.archived ?? false,
          limit: input.limit ?? LIST_DEFAULT_LIMIT,
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(labels === undefined || labels.length === 0 ? {} : { labels }),
        });
        const marks = yield* pendingOf(caller, ports);
        const colours = yield* labelColoursOf(caller, ports, [...new Set(found.artifacts.map((artifact) => artifact.nodeId))]);
        return {
          artifacts: found.artifacts.map(({ artifactId, nodeId, type, title, version, updatedAt, archived, labels }) => {
            const labelColours = coloursOf(colours, nodeId, labels);
            return withPendingMark({
              artifactId, nodeId, type, title, version, updatedAt, archived, labels,
              ...(labelColours === undefined ? {} : { labelColours }),
            }, artifactId, marks);
          }),
          more: found.more,
          ...pendingUnknownOf(marks),
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
        const marks = yield* pendingOf(caller, ports);
        const artifact = withPendingMark(head.artifact, head.artifact.artifactId, marks);
        const linkedFrom = yield* linkedFromOf(caller, ports, head.artifact);
        const labelColours = coloursOf(yield* labelColoursOf(caller, ports, [head.artifact.nodeId]), head.artifact.nodeId, head.artifact.labels);
        return {
          artifact, version, text: artifactText(body), body, linkedFrom,
          ...(labelColours === undefined ? {} : { labelColours }),
          ...pendingUnknownOf(marks),
        } satisfies ArtifactShowResult;
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
        const labels = input.labels === undefined ? undefined : yield* foldLabels(input.labels, "labels");
        const resolve = yield* titleResolver(caller, ports, bodyTexts(body.success));
        const linked = resolve === undefined ? body.success : yield* Effect.fromResult(linkBodyTitles(body.success, resolve)).pipe(Effect.mapError(withOpId(input.opId)));
        return yield* submit(caller, ports, command(caller, input.opId, node.id, input.artifactId, {
          op: "create",
          title: input.title,
          body: linked,
          ...(input.taskIds === undefined ? {} : { taskIds: input.taskIds }),
          ...(labels === undefined || labels.length === 0 ? {} : { labels }),
        }));
      }
      case "artifact.label": {
        const input = yield* decode(ArtifactLabelArgs, args);
        const head = yield* findArtifact(caller, ports, input.artifact);
        // A labels write still queued for the editing machine is what this seat last set: build on it.
        const queued = ports.queuedLabels === undefined ? Option.none() : yield* ports.queuedLabels(caller.canvasName, input.artifact);
        const held = Option.isSome(queued) ? (artifactLabelsOf(queued.value) ?? head.artifact.labels) : head.artifact.labels;
        const labels = yield* nextLabels(held, input).pipe(Effect.mapError(withOpId(input.opId)));
        return yield* submit(caller, ports, command(caller, input.opId, head.artifact.nodeId, input.artifact, { op: "labels", labels }));
      }
      case "artifact.edit": {
        const input = yield* decode(ArtifactEditArgs, args);
        const head = yield* findArtifact(caller, ports, input.artifact);
        const edit = editFor(head, input);
        if (Result.isFailure(edit)) return yield* Effect.fail(edit.failure);
        const resolve = yield* titleResolver(caller, ports, editTexts(edit.success));
        const linked = resolve === undefined ? edit.success : yield* linkEdit(caller, ports, head, edit.success, resolve).pipe(Effect.mapError(withOpId(input.opId)));
        return yield* submit(caller, ports, command(caller, input.opId, head.artifact.nodeId, input.artifact, {
          op: "edit",
          edit: linked,
        }));
      }
      case "artifact.colour": {
        const input = yield* decode(ArtifactColourArgs, args);
        const node = yield* findNode(caller, ports, input.node);
        const label = artifactLabelOf(input.label);
        if (label === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: notALabel(input.label),
            details: { path: "label", received: input.label, retryable: false, opId: input.opId },
          });
        }
        if (ports.colourLabel === undefined) return yield* Effect.fail({ ...notBuilt, message: "label colours are not held by this build yet", details: { ...notBuilt.details, opId: input.opId } });
        const write: LabelColourWrite = { opId: input.opId, canvasName: caller.canvasName, actor: caller.actor, nodeId: node.id, label, colour: input.colour };
        const outcome = yield* ports.colourLabel(write, rulingContext(caller));
        if (outcome.kind === "refused") return yield* Effect.fail(withOpId(outcome.opId)(outcome.error));
        return { disposition: outcome.kind, opId: outcome.opId, nodeId: node.id, label, colour: input.colour } satisfies ArtifactColourResult;
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
    // Read before admitsAnchor narrows the refused anchor away.
    const askedKind = input.anchor?.kind;
    if (input.anchor !== undefined && head.body !== null && !admitsAnchor(head.body, input.anchor)) {
      const type = head.artifact.type;
      const kinds: ReadonlyArray<string> = ANCHOR_KINDS[type];
      const quoteMissing = askedKind === "text" && type === "document";
      const refused = inputError(
        quoteMissing
          ? `the quote is not in this document at version ${head.artifact.version}`
          : kinds.includes(askedKind ?? "")
            ? `a ${type} does not take this ${askedKind} anchor`
            : `a ${type} does not take a ${askedKind} anchor`,
        "anchor",
        type === "sheet" ? "a cells anchor is an A1 range, like B2 or A1:C4" : undefined,
      );
      return yield* Effect.fail<WorkErrorBody>({
        ...refused,
        details: {
          ...refused.details,
          next_step: quoteMissing
            ? "quote the text exactly as junto artifact show prints it, or leave --anchor out to comment on the whole document"
            : `anchor it with ${kinds.join(" or ")}, or leave --anchor out to comment on the whole ${type}`,
        },
      });
    }
    const anchor = input.anchor === undefined ? undefined : subjectAnchorOf(input.anchor);
    // `whole` is no anchor. The wire Anchor still spells the file's places,
    // which no artifact takes, so the check narrows it to an artifact's place.
    if (anchor?.kind === "lines" || anchor?.kind === "pageBox") {
      return yield* Effect.fail(inputError(`a ${head.artifact.type} does not take a ${anchor.kind === "lines" ? "lines" : "page box"} anchor`, "anchor"));
    }
    // Each mention becomes its link: in reach of the artifact, whoever writes (03).
    const callerId = caller.actor.kind === "seat" ? caller.actor.nodeId : operatorActorRef(caller.canvasName).nodeId;
    const linked = yield* linkMentionsAt(caller.canvas, caller.canvasName, callerId, input.text, { kind: "comments", nodeId: head.artifact.nodeId }).pipe(
      Effect.mapError((error): WorkErrorBody => ({ ...error, details: { ...error.details, opId: input.opId } })),
    );
    const text = linked.text;
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
      ...unlinkedField(linked),
    } satisfies ArtifactCommentResult;
  });
