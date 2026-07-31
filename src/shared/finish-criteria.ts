import { Schema } from "effect";
import type { Artifact, FinishCriteria, CompletionEvidence, Task } from "./work-model";
import { FinishCriteria as FinishCriteriaSchema, CompletionEvidence as CompletionEvidenceSchema } from "./work-model";

/**
 * Operator-authored finish criteria and agent-supplied completion evidence.
 * Pure checks only — no I/O. Gate runs on → completed at the task home.
 */

export const decodeFinishCriteria = (
  value: unknown,
): FinishCriteria | undefined => {
  if (value === undefined || value === null) return undefined;
  return Schema.decodeUnknownSync(FinishCriteriaSchema)(value);
};

export const decodeCompletionEvidence = (
  value: unknown,
): CompletionEvidence | undefined => {
  if (value === undefined || value === null) return undefined;
  return Schema.decodeUnknownSync(CompletionEvidenceSchema)(value);
};

/** Normalize optional criteria; empty object becomes undefined. */
export const normalizeFinishCriteria = (
  criteria: FinishCriteria | undefined,
): FinishCriteria | undefined => {
  if (criteria === undefined) return undefined;
  const description = criteria.description?.trim();
  const artifacts = criteria.artifacts;
  const git = criteria.git;

  const nextArtifacts =
    artifacts === undefined
      ? undefined
      : {
          nodeId: artifacts.nodeId.trim(),
          ...(artifacts.instruction?.trim()
            ? { instruction: artifacts.instruction.trim() }
            : {}),
          ...(artifacts.names !== undefined && artifacts.names.length > 0
            ? {
                names: [
                  ...new Set(
                    artifacts.names
                      .map((n) => n.trim())
                      .filter((n) => n.length > 0),
                  ),
                ],
              }
            : {}),
        };

  const nextGit =
    git === undefined
      ? undefined
      : { minCommits: Math.max(1, Math.floor(git.minCommits)) };

  if (
    (description === undefined || description.length === 0) &&
    nextArtifacts === undefined &&
    nextGit === undefined
  ) {
    return undefined;
  }

  if (nextArtifacts !== undefined && nextArtifacts.nodeId.length === 0) {
    throw new Error("finishCriteria.artifacts.nodeId must be non-empty");
  }

  return {
    ...(description && description.length > 0 ? { description } : {}),
    ...(nextArtifacts !== undefined ? { artifacts: nextArtifacts } : {}),
    ...(nextGit !== undefined ? { git: nextGit } : {}),
  };
};

export const normalizeCompletionEvidence = (
  evidence: CompletionEvidence | undefined,
): CompletionEvidence | undefined => {
  if (evidence === undefined) return undefined;
  const artifacts = evidence.artifacts.map((a) => ({
    artifactId: a.artifactId.trim(),
    nodeId: a.nodeId.trim(),
  }));
  const commits = evidence.git?.commits
    ?.map((c) => c.trim())
    .filter((c) => c.length > 0);

  return {
    artifacts,
    ...(commits !== undefined && commits.length > 0
      ? { git: { commits } }
      : evidence.git !== undefined
        ? { git: { commits: [] } }
        : {}),
  };
};

export type FinishCriteriaFailure = {
  readonly missing: string;
  readonly message: string;
  readonly next_step: string;
};

/**
 * Deterministic complete gate.
 *
 * - No criteria → ok
 * - artifacts gate: evidence must cite ≥1 artifact on the required node;
 *   each must exist and link to this task via Artifact.task; named set exact
 * - git gate: evidence.git.commits length ≥ minCommits
 */
export const evaluateFinishCriteria = (params: {
  readonly task: Task;
  readonly taskNodeId: string;
  readonly canvasName: string;
  readonly evidence: CompletionEvidence | undefined;
  /** Artifacts visible in the local projection (all sinks). */
  readonly artifactsByNode: ReadonlyMap<string, ReadonlyArray<Artifact>>;
}): FinishCriteriaFailure | undefined => {
  const criteria = params.task.finishCriteria;
  if (criteria === undefined) return undefined;

  const evidence = params.evidence;

  if (criteria.artifacts !== undefined) {
    const requiredNodeId = criteria.artifacts.nodeId;
    const cited = evidence?.artifacts ?? [];
    if (cited.length === 0) {
      return {
        missing: "artifacts",
        message: `task "${params.task.id}" requires at least one completion artifact on node "${requiredNodeId}"`,
        next_step:
          "Publish artifact(s) to the artifacts node with task linkage, then complete with completionEvidence.artifacts",
      };
    }
    for (const ref of cited) {
      if (ref.nodeId !== requiredNodeId) {
        return {
          missing: "artifacts.nodeId",
          message: `completion artifact "${ref.artifactId}" is on node "${ref.nodeId}", expected "${requiredNodeId}"`,
          next_step: `Cite artifacts only from node "${requiredNodeId}"`,
        };
      }
      const shelf = params.artifactsByNode.get(ref.nodeId) ?? [];
      const found = shelf.find((a) => a.artifactId === ref.artifactId);
      if (found === undefined) {
        return {
          missing: "artifacts.exist",
          message: `completion artifact "${ref.artifactId}" not found on node "${ref.nodeId}"`,
          next_step: "Publish the artifact before completing, or fix the evidence ids",
        };
      }
      const link = found.task;
      if (
        link === undefined ||
        link.itemId !== params.task.id ||
        link.sink.nodeId !== params.taskNodeId ||
        link.sink.canvasName !== params.canvasName
      ) {
        return {
          missing: "artifacts.taskLink",
          message: `artifact "${ref.artifactId}" is not linked to task "${params.task.id}"`,
          next_step:
            "Re-publish (or publish) with task: { target: <task-sink>, id: <task-id> }",
        };
      }
    }
    const names = criteria.artifacts.names;
    if (names !== undefined && names.length > 0) {
      const present = new Set(
        cited.flatMap((ref) => {
          const shelf = params.artifactsByNode.get(ref.nodeId) ?? [];
          const found = shelf.find((a) => a.artifactId === ref.artifactId);
          const name = found?.name?.trim();
          return name ? [name] : [];
        }),
      );
      for (const required of names) {
        if (!present.has(required)) {
          return {
            missing: "artifacts.names",
            message: `required artifact name "${required}" is not present in completion evidence`,
            next_step: `Publish an artifact named exactly "${required}" linked to this task and cite it`,
          };
        }
      }
    }
  }

  if (criteria.git !== undefined) {
    const commits = evidence?.git?.commits ?? [];
    if (commits.length < criteria.git.minCommits) {
      return {
        missing: "git.commits",
        message: `task "${params.task.id}" requires at least ${criteria.git.minCommits} git commit(s); got ${commits.length}`,
        next_step:
          "Commit work, then complete with completionEvidence.git.commits: [\"<sha>\", ...]",
      };
    }
  }

  return undefined;
};

/** Collect ether.artifacts from every node on the doc. */
export const artifactsByNodeFromDoc = (
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly ether?: {
      readonly artifacts?: { readonly items?: ReadonlyArray<Artifact> };
    };
  }>,
): Map<string, ReadonlyArray<Artifact>> => {
  const map = new Map<string, ReadonlyArray<Artifact>>();
  for (const node of nodes) {
    const items = node.ether?.artifacts?.items;
    if (items !== undefined && items.length > 0) {
      map.set(node.id, items);
    }
  }
  return map;
};
