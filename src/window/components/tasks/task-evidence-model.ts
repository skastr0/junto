/**
 * A finish's evidence as the task pane reads it, pure: the artifacts it cites
 * grouped by the Artifacts node they sit on, the commits it names, what it
 * claimed and what it waived.
 */
import type { CompletionEvidence } from "@shared/work-model";

export type EvidenceGroup = {
  readonly nodeId: string;
  readonly artifactIds: ReadonlyArray<string>;
};

/** The cited artifacts by node, in the order first cited, each id once. */
export const evidenceGroups = (evidence: CompletionEvidence): ReadonlyArray<EvidenceGroup> => {
  const by = new Map<string, string[]>();
  for (const { nodeId, artifactId } of evidence.artifacts) {
    const ids = by.get(nodeId) ?? [];
    if (!ids.includes(artifactId)) ids.push(artifactId);
    by.set(nodeId, ids);
  }
  return [...by].map(([nodeId, artifactIds]) => ({ nodeId, artifactIds }));
};

/** A commit as people say it: its first seven characters. */
export const shortCommit = (sha: string): string => sha.slice(0, 7);

/** Whether a finish left anything to show. */
export const hasEvidence = (evidence: CompletionEvidence | undefined, handoff: string | undefined): boolean =>
  (handoff !== undefined && handoff.trim() !== "") ||
  (evidence !== undefined &&
    (evidence.artifacts.length > 0 ||
      (evidence.git?.commits.length ?? 0) > 0 ||
      (evidence.claims?.length ?? 0) > 0 ||
      (evidence.waivers?.length ?? 0) > 0));
