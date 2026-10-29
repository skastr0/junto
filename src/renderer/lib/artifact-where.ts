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

export const readArtifactWhereItIs = async (canvasName: string, hint: NodeId, artifactId: ItemId): Promise<ArtifactWhereItIs> => {
  const listed = (nodeId: NodeId) => artifactsSource().list(canvasName, nodeId).catch((): ReadonlyArray<ArtifactHead> => []);
  const heads = await listed(hint);
  if (heads.some((head) => head.artifact.artifactId === artifactId)) return { nodeId: hint, heads };
  const moves = await artifactsSource().moves(canvasName, artifactId).catch(() => []);
  const now = moves.at(-1)?.to;
  return now === undefined || now === hint ? { nodeId: hint, heads } : { nodeId: now, heads: await listed(now) };
};

/**
 * `readArtifactWhereItIs`, read again on any artifact change on the canvas;
 * undefined until the first read for this link lands, so a read for another
 * link is never shown for this one.
 */
export const useArtifactWhereItIs = (canvasName: string, hint: NodeId, artifactId: ItemId): ArtifactWhereItIs | undefined => {
  const key = `${canvasName}\u0000${hint}\u0000${artifactId}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly where: ArtifactWhereItIs } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void readArtifactWhereItIs(canvasName, hint, artifactId).then((where) => {
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
  }, [canvasName, hint, artifactId, key]);
  return held?.key === key ? held.where : undefined;
};
