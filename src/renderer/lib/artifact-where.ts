/**
 * Find a linked artifact by its id (plan 0.11.1, 10). A link stores the node
 * the artifact was on when it was written; that node is only a hint. An
 * artifact the hint does not hold is read where its last move took it, so a
 * link written before a move still opens it, titled and judged where it is
 * now. One that never moved, or is nowhere, reads as the hint's node, so it
 * stays missing there.
 */
import { useEffect, useState } from "react";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { ItemId } from "@shared/work-ids";
import { artifactsSource } from "./artifacts-source";

/** Where a link's artifact is now: the node that holds it, and that node's artifacts. */
export type ArtifactWhereItIs = { readonly nodeId: NodeId; readonly heads: ReadonlyArray<ArtifactHead> };

const listed = (canvasName: string, nodeId: NodeId): Promise<ReadonlyArray<ArtifactHead>> =>
  artifactsSource().list(canvasName, nodeId).catch((): ReadonlyArray<ArtifactHead> => []);

/** The node an artifact's last move took it to; none when it never moved, or its moves cannot be read. */
const movedTo = async (canvasName: string, artifactId: ItemId): Promise<NodeId | undefined> => {
  try {
    return (await artifactsSource().moves(canvasName, artifactId)).at(-1)?.to;
  } catch {
    return undefined;
  }
};

/**
 * An artifact a link's node did not hold, read where it moved: that node and
 * its artifacts, or undefined when it never left `hint` or is held nowhere.
 */
export const readArtifactMovedFrom = async (canvasName: string, hint: NodeId, artifactId: ItemId): Promise<ArtifactWhereItIs | undefined> => {
  const now = await movedTo(canvasName, artifactId);
  if (now === undefined || now === hint) return undefined;
  const heads = await listed(canvasName, now);
  return heads.some((head) => head.artifact.artifactId === artifactId) ? { nodeId: now, heads } : undefined;
};

export const readArtifactWhereItIs = async (canvasName: string, hint: NodeId, artifactId: ItemId): Promise<ArtifactWhereItIs> => {
  const heads = await listed(canvasName, hint);
  if (heads.some((head) => head.artifact.artifactId === artifactId)) return { nodeId: hint, heads };
  return (await readArtifactMovedFrom(canvasName, hint, artifactId)) ?? { nodeId: hint, heads };
};

/**
 * `readArtifactWhereItIs`, read again on any artifact change on the canvas;
 * undefined until the first read for this link lands, so a read for another
 * link is never shown for this one.
 */
export const useArtifactWhereItIs = (canvasName: string, hint: NodeId, artifactId: ItemId): ArtifactWhereItIs | undefined =>
  useRead(canvasName, hint, artifactId, readArtifactWhereItIs);

/** `readArtifactMovedFrom`, kept current: for a surface that has read the hint's node itself. Undefined until found. */
export const useArtifactMovedFrom = (canvasName: string, hint: NodeId, artifactId: ItemId): ArtifactWhereItIs | undefined =>
  useRead(canvasName, hint, artifactId, readArtifactMovedFrom);

const useRead = (
  canvasName: string,
  hint: NodeId,
  artifactId: ItemId,
  read: (canvasName: string, hint: NodeId, artifactId: ItemId) => Promise<ArtifactWhereItIs | undefined>,
): ArtifactWhereItIs | undefined => {
  const key = `${canvasName}\u0000${hint}\u0000${artifactId}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly where: ArtifactWhereItIs | undefined } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void read(canvasName, hint, artifactId).then((where) => {
        if (live) setHeld({ key, where });
      });
    };
    refresh();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, hint, artifactId, key, read]);
  return held?.key === key ? held.where : undefined;
};
