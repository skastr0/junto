import { Effect, Option, Result } from "effect";
import type { AgentSignalAttachmentInput } from "@shared/agent-signals";
import { mentionHref } from "@shared/mention";
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { resourcesInReach } from "@shared/region-reach";
import type { TaskNumber } from "@shared/task-model";
import type { TargetCandidate, WorkErrorBody } from "@shared/work-control";
import { isItemId, type ItemId } from "@shared/work-ids";
import { ArtifactRepository } from "../work/artifact-repository";
import { resolveWorkTarget } from "../work/authz";
import { TaskRepository } from "../work/task-repository";
import type { SignalResources } from "./attachments";

/**
 * A task or an artifact a seat attaches to a signal, as it typed it: a
 * `junto://` ref, a task's `#42`, or an item id. Main resolves each against
 * what is in the seat's reach into the canonical ref (`mentionHref`), and
 * `admitResourceAttachment` then judges that ref. The items read here are
 * also what `SignalResources.holds` answers from, so both see one snapshot.
 */

export type ResourceKind = "task" | "artifact";

type ResourceInput = Extract<AgentSignalAttachmentInput, { readonly kind: ResourceKind }>;

/** One task or artifact in the seat's reach, as resolution and `holds` see it. */
export type ReachedItem = {
  readonly kind: ResourceKind;
  readonly nodeId: NodeId;
  readonly itemId: ItemId;
  readonly name: string;
  readonly number?: TaskNumber;
  /** An archived artifact: found, so it is not called missing, but not attached. */
  readonly archived?: true;
};

const NODE_KIND = { task: "task", artifact: "artifacts" } as const satisfies Record<ResourceKind, string>;

const isResourceInput = (input: AgentSignalAttachmentInput): input is ResourceInput =>
  "kind" in input && (input.kind === "task" || input.kind === "artifact");

const candidateOf = (item: ReachedItem): TargetCandidate => ({
  kind: NODE_KIND[item.kind],
  nodeId: item.nodeId,
  itemId: item.itemId,
  name: item.name,
  ...(item.number === undefined ? {} : { number: item.number }),
});

/**
 * Pure: what the seat typed, as the canonical ref of one item. A bare item
 * id is looked up among the items in reach; anything else goes through
 * `resolveWorkTarget`, which refuses with the candidates. A target that
 * resolves to a node and not to an item in it is refused too.
 */
export const resolveResourceRef = (
  board: Canvas,
  canvasName: string,
  seatId: NodeId,
  input: ResourceInput,
  items: ReadonlyArray<ReachedItem>,
): Result.Result<ResourceInput, WorkErrorBody> => {
  const typed = input.ref.trim();
  const ofKind = items.filter((item) => item.kind === input.kind);
  const linked = (nodeId: NodeId, itemId: ItemId): ResourceInput => ({
    ...input,
    ref: mentionHref(
      input.kind === "task" ? { kind: "task", nodeId, taskId: itemId } : { kind: "artifact", nodeId, artifactId: itemId },
      canvasName,
    ),
  });
  const archived = (item: ReachedItem): Result.Result<ResourceInput, WorkErrorBody> =>
    Result.fail({
      type: "InvalidTransition",
      message: `${input.kind} ${item.itemId} is archived`,
      details: { target: typed, retryable: false, next_step: "restore it first, or attach another" },
    });
  if (isItemId(typed)) {
    const found = ofKind.find((item) => item.itemId === typed);
    if (found?.archived === true) return archived(found);
    return found !== undefined
      ? Result.succeed(linked(found.nodeId, found.itemId))
      : Result.fail({
          type: "UnknownTarget",
          message: `no ${input.kind} ${typed} in this seat's reach`,
          details: { target: typed, retryable: false, next_step: `send the ${input.kind}'s ref exactly as Junto printed it` },
        });
  }
  const live = ofKind.filter((item) => item.archived !== true);
  const resolved = resolveWorkTarget(board, seatId, typed, "signal.raise", () => live.map(candidateOf));
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  const { nodeId, itemId } = resolved.success;
  if (itemId !== undefined) {
    const found = ofKind.find((item) => item.nodeId === nodeId && item.itemId === itemId);
    return found?.archived === true ? archived(found) : Result.succeed(linked(nodeId, itemId));
  }
  const inNode = live.filter((item) => item.nodeId === nodeId).map(candidateOf);
  return Result.fail({
    type: "InputError",
    message: `"${typed}" names a node, not a ${input.kind} in it`,
    details: {
      target: typed,
      retryable: false,
      candidates: inNode,
      next_step: input.kind === "task" ? "name the task: #42, its id, or its ref" : "name the artifact by its id or its ref",
    },
  });
};

/** Pure: whether an item is on its node now, by the items read for this signal. */
export const holdsOf = (items: ReadonlyArray<ReachedItem>): SignalResources["holds"] => {
  const held = new Set(items.filter((item) => item.archived !== true).map((item) => `${item.kind}:${item.nodeId}:${item.itemId}`));
  return (kind, nodeId, item) => held.has(`${kind}:${nodeId}:${item}`);
};

const SCAN_LIMIT = 10_000;

const storeError = (error: { readonly message: string }): WorkErrorBody => ({
  type: "InternalError",
  message: error.message,
  details: { retryable: true },
});

/**
 * Every task or artifact in the seat's reach, of the kinds the signal names,
 * read from the task store and the artifact store, archived artifacts too.
 * A store this runtime does not run is named in `missing`: only that kind is
 * refused. Past `SCAN_LIMIT` items of one kind the rest read as not in reach.
 */
const readReachedItems = (
  board: Canvas,
  canvasName: string,
  seatId: NodeId,
  kinds: ReadonlySet<ResourceKind>,
): Effect.Effect<{ readonly items: ReadonlyArray<ReachedItem>; readonly missing: ReadonlySet<ResourceKind> }, WorkErrorBody> =>
  Effect.gen(function* () {
    const reached = resourcesInReach(board, seatId);
    const nodesOf = (kind: ResourceKind) => reached.filter((node) => node.kind === NODE_KIND[kind]).map((node) => node.id);
    const items: ReachedItem[] = [];
    const missing = new Set<ResourceKind>();
    if (kinds.has("task")) {
      const repo = yield* Effect.serviceOption(TaskRepository);
      const nodeIds = nodesOf("task");
      if (Option.isNone(repo)) missing.add("task");
      else if (nodeIds.length > 0) {
        const { tasks } = yield* repo.value.list(canvasName, { nodeIds, limit: SCAN_LIMIT }).pipe(Effect.mapError(storeError));
        for (const task of tasks) {
          items.push({
            kind: "task",
            nodeId: task.current.node,
            itemId: task.taskId,
            name: task.title,
            ...(task.number === undefined ? {} : { number: task.number }),
          });
        }
      }
    }
    if (kinds.has("artifact")) {
      const repo = yield* Effect.serviceOption(ArtifactRepository);
      const nodeIds = nodesOf("artifact");
      if (Option.isNone(repo)) missing.add("artifact");
      else if (nodeIds.length > 0) {
        for (const archived of [false, true]) {
          const { artifacts } = yield* repo.value
            .list(canvasName, { nodeIds, archived, limit: SCAN_LIMIT })
            .pipe(Effect.mapError(storeError));
          for (const artifact of artifacts) {
            items.push({
              kind: "artifact",
              nodeId: artifact.nodeId,
              itemId: artifact.artifactId,
              name: artifact.title,
              ...(archived ? { archived: true as const } : {}),
            });
          }
        }
      }
    }
    return { items, missing };
  });

/**
 * A signal's attach list with every task and artifact ref made canonical,
 * and what `claimSignalAttachments` judges them against. Without a task or an
 * artifact in the list nothing is read and no resources are given.
 */
export const signalResourcesFor = (
  board: Canvas,
  canvasName: string,
  seatId: NodeId,
  inputs: ReadonlyArray<AgentSignalAttachmentInput>,
): Effect.Effect<
  { readonly inputs: ReadonlyArray<AgentSignalAttachmentInput>; readonly resources?: SignalResources },
  WorkErrorBody
> =>
  Effect.gen(function* () {
    const kinds = new Set(inputs.filter(isResourceInput).map((input) => input.kind));
    if (kinds.size === 0) return { inputs };
    const { items, missing } = yield* readReachedItems(board, canvasName, seatId, kinds);
    const resolved = yield* Effect.forEach(inputs, (input, index): Effect.Effect<AgentSignalAttachmentInput, WorkErrorBody> =>
      isResourceInput(input)
        ? Effect.fromResult(
            missing.has(input.kind)
              ? Result.fail<WorkErrorBody>({
                  type: "InputError",
                  message: `${input.kind}s cannot be attached in this Junto runtime`,
                  details: { reason: "not_available", retryable: false },
                })
              : resolveResourceRef(board, canvasName, seatId, input, items),
          ).pipe(
            Effect.mapError((error): WorkErrorBody => ({
              ...error,
              details: { ...error.details, path: `args.attach[${index}]` },
            })),
          )
        : Effect.succeed(input),
    );
    return { inputs: resolved, resources: { canvas: board, holds: holdsOf(items) } };
  });
