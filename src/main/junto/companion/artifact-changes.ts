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
import { AppRuntime } from "../../runtime";
import { ArtifactRepository } from "../work/artifact-repository";

const encoder = new TextEncoder();

/** One change at a time, so two writes to one artifact reach the phone in the order they were ruled. */
let tail: Promise<unknown> = Promise.resolve();

const readHead = (canvasName: string, artifactId: Parameters<CompanionChanges["noteArtifact"]>[0]["artifact"]["artifactId"]) =>
  AppRuntime.runPromise(
    Effect.flatMap(ArtifactRepository, (repository) => repository.head(canvasName, artifactId)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );

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
