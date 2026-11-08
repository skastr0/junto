/**
 * `artifact.changed` on the phone: one event per artifact write, by anyone who
 * writes through this machine, carrying the head, who wrote it, and the edit
 * when it fits a frame.
 *
 * The desktop's change notice says which command was ruled
 * (`resource-changes.ts`), so this reads the head the write left and hands the
 * event to the companion change clock. A row replicated from another machine
 * arrives without a command: the canvas's artifacts moved, but nothing here
 * can name one, so no event is made for it.
 */
import { Effect, Option } from "effect";
import type { CompanionChanges } from "./changes";
import type { ArtifactChange } from "../work/resource-changes";
import type { CompanionArtifactChanged } from "@shared/wire/companion-artifacts";
import { COMPANION_ARTIFACT_EDIT_MAX_BYTES } from "@shared/wire/companion-artifacts";
import { CompanionRuntime } from "./runtime";
import { ModelService } from "../model/service";
import { ArtifactRepository } from "../work/artifact-repository";

const encoder = new TextEncoder();

/** One change at a time, so two writes to one artifact reach the phone in the order they were ruled. */
let tail: Promise<unknown> = Promise.resolve();

const readHead = (canvasName: string, artifactId: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["artifactId"]) =>
  CompanionRuntime.runPromise(
    Effect.flatMap(ArtifactRepository, (repository) => repository.head(canvasName, artifactId)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );

/** One artifact head, as the replicated-row scan reads it. */
export type ScannedHead = {
  readonly artifactId: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["artifactId"];
  readonly nodeId: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["nodeId"];
  readonly type: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["type"];
  readonly title: string;
  readonly version: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly labels: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["labels"];
  readonly bodyRef?: Parameters<CompanionChanges["noteArtifact"]>[0]["bodyRef"];
};

/** Every artifact head a canvas's Artifacts nodes hold now, as the list reads them. */
const scanHeads = async (canvasName: string): Promise<ReadonlyArray<ScannedHead>> => {
  const heads = await CompanionRuntime.runPromise(
    Effect.gen(function* () {
      const repository = yield* ArtifactRepository;
      const nodes = yield* Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(
        Effect.map((canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "artifacts").map((node) => node.id)),
      );
      const out: Array<ScannedHead> = [];
      for (const nodeId of nodes) {
        const listed = yield* repository.list(canvasName, { nodeIds: [nodeId], archived: false, limit: 200 }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (listed === undefined) continue;
        for (const item of listed.artifacts) {
          const head = yield* repository.head(canvasName, item.artifactId).pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isNone(head)) continue;
          out.push({
            artifactId: head.value.artifact.artifactId,
            nodeId: head.value.artifact.nodeId,
            type: head.value.artifact.type,
            title: head.value.artifact.title,
            version: head.value.artifact.version,
            updatedAt: head.value.artifact.updatedAt,
            archived: head.value.artifact.archived,
            labels: head.value.artifact.labels,
            bodyRef: head.value.bodyRef,
          });
        }
      }
      return out;
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ScannedHead>))),
  );
  return heads;
};

/** The version each canvas's artifacts were last seen at, so a replicated row names what moved. */
const seen = new Map<string, ReadonlyMap<string, number>>();

/**
 * A notice with no command: a ruling folded here that another machine made.
 * Read the heads and name every artifact whose version rose; the phone
 * refetches, since the edit itself did not cross.
 */
export const noteArtifactCanvasChanged = (
  changes: CompanionChanges,
  canvasName: string,
  scan: (canvasName: string) => Promise<ReadonlyArray<ScannedHead>> = scanHeads,
): void => {
  const run = tail.then(async () => {
    const heads = await scan(canvasName);
    const before = seen.get(canvasName);
    const next = new Map(heads.map((head) => [head.artifactId as string, head.version] as const));
    seen.set(canvasName, next);
    // The first look is this process's baseline: nothing is "new" until it moves.
    if (before === undefined) return;
    for (const head of heads) {
      const was = before.get(head.artifactId as string);
      if (was !== undefined && was >= head.version) continue;
      changes.noteArtifact({
        canvasName,
        artifact: {
          artifactId: head.artifactId,
          nodeId: head.nodeId,
          type: head.type,
          title: head.title,
          version: head.version as never,
          updatedAt: head.updatedAt,
          archived: head.archived,
          labels: head.labels,
        },
        author: { kind: "operator" },
        at: Date.now(),
        ...(head.bodyRef === undefined ? {} : { bodyRef: head.bodyRef }),
      });
    }
  });
  tail = run.catch(() => undefined);
  void run.catch(() => undefined);
};

const artifactEvent = async (canvasName: string, change: ArtifactChange): Promise<CompanionArtifactChanged | undefined> => {
  const artifactId = change.command.target.itemId;
  // A command on the node itself (a label colour) names no artifact.
  if (artifactId === undefined) return undefined;
  const head = await readHead(canvasName, artifactId);
  if (head === undefined) return undefined;
  // Only an edit carries a patch; a retitle, labels, archive or move is the head alone.
  const edit = change.command.op.op === "edit" ? change.command.op.edit : undefined;
  const fits = edit !== undefined && encoder.encode(JSON.stringify(edit)).byteLength <= COMPANION_ARTIFACT_EDIT_MAX_BYTES;
  return {
    canvasName,
    artifact: {
      artifactId: head.artifact.artifactId,
      nodeId: head.artifact.nodeId,
      type: head.artifact.type,
      title: head.artifact.title,
      version: head.artifact.version,
      updatedAt: head.artifact.updatedAt,
      archived: head.artifact.archived,
      labels: head.artifact.labels,
    },
    author: change.command.actor,
    at: Date.now(),
    ...(fits && edit !== undefined ? { edit } : {}),
    bodyRef: head.bodyRef,
  };
};

/** Note one artifact write on the companion clock; a no-command notice makes no event. */
export const noteArtifactChanged = (
  changes: CompanionChanges,
  canvasName: string,
  change: ArtifactChange | undefined,
): void => {
  if (change === undefined) return;
  const run = tail.then(async () => {
    const event = await artifactEvent(canvasName, change);
    if (event !== undefined) changes.noteArtifact(event);
  });
  tail = run.catch(() => undefined);
  void run.catch(() => undefined);
};
