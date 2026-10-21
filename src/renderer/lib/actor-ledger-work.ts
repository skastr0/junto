import type { Artifact } from "@shared/work-model";
import type { ActorSeatId } from "@shared/actor-seat";
import type { Part } from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { isArtifactArchived } from "@shared/work";

/**
 * Pure projections of an actor's work-kernel standing for ledger-style UI:
 * the artifacts it published. The caller supplies independently queried Work rows.
 */

export type ArtifactRow = {
  readonly artifactId: string;
  readonly sinkNodeId: string;
  readonly name: string;
  readonly partCount: number;
  /** First text part, clipped by the caller for display. */
  readonly textPreview: string | undefined;
  readonly archived: boolean;
};

/** Seat identity for an actor node from the compiled seat projection. */
export const seatIdForActorNode = (
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ActorSeatId | undefined =>
  actorRefs.find((candidate) => candidate.nodeId === nodeId)?.seatId;

const firstTextPart = (parts: ReadonlyArray<Part>): string | undefined => {
  for (const part of parts) {
    if (part.kind === "text") {
      const text = part.text.trim();
      if (text) return text;
    }
  }
  return undefined;
};

/**
 * Artifacts this seat published, across every artifacts sink in the doc.
 * Publisher identity is the projection-stamped metadata.publishedBySeatId
 * (never durable row data). Newest first; archived excluded.
 */
export const artifactRowsForSeat = (
  entries: ReadonlyArray<{ readonly nodeId: string; readonly item: Artifact }>,
  seatId: ActorSeatId,
): ReadonlyArray<ArtifactRow> => {
  const rows: ArtifactRow[] = [];
  for (const { nodeId, item: artifact } of entries) {
      if (artifact.metadata?.["publishedBySeatId"] !== seatId) continue;
      const archived = isArtifactArchived(artifact);
      if (archived) continue;
      rows.push({
        artifactId: artifact.artifactId,
        sinkNodeId: nodeId,
        name: artifact.name?.trim() || artifact.artifactId,
        partCount: artifact.parts.length,
        textPreview: firstTextPart(artifact.parts),
        archived,
      });
  }
  return rows.sort((a, b) => b.artifactId.localeCompare(a.artifactId));
};
