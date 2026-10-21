import { BadgeCheck } from "lucide-react";
import { asNodeId } from "@shared/physics/schema";
import type { CompletionEvidence } from "@shared/work-model";
import { useNodeArtifacts } from "../../lib/artifacts-source";
import { openWorkDetail } from "../../lib/work-detail-open";
import { Eyebrow, ResourceChip } from "../ui";
import { evidenceGroups, hasEvidence, shortCommit } from "./task-evidence-model";

/** The cited artifacts of one Artifacts node, named by their titles, each a chip that opens it. */
function EvidenceArtifacts({
  canvasName,
  nodeId,
  artifactIds,
}: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly artifactIds: ReadonlyArray<string>;
}) {
  const heads = useNodeArtifacts(canvasName, asNodeId(nodeId));
  return (
    <>
      {artifactIds.map((id) => {
        const head = heads.find((entry) => entry.artifact.artifactId === id);
        return head === undefined ? (
          <ResourceChip key={id} kind="artifact" label="Unavailable" missing />
        ) : (
          <ResourceChip
            key={id}
            kind="artifact"
            artifactType={head.artifact.type}
            label={head.artifact.title}
            onOpen={() => openWorkDetail(nodeId, { itemId: id })}
          />
        );
      })}
    </>
  );
}

/**
 * What a finish left (plan 05): the handoff note, the artifacts it cites as
 * chips that open, the commits, what it claimed and what it waived. Nothing
 * when it left nothing.
 */
export function TaskEvidence({
  canvasName,
  evidence,
  handoff,
  label = "Evidence",
}: {
  readonly canvasName: string;
  readonly evidence?: CompletionEvidence;
  readonly handoff?: string;
  readonly label?: string;
}) {
  if (!hasEvidence(evidence, handoff)) return null;
  const groups = evidence === undefined ? [] : evidenceGroups(evidence);
  const commits = evidence?.git?.commits ?? [];
  const claims = evidence?.claims ?? [];
  const waivers = evidence?.waivers ?? [];
  return (
    <section className="task-evidence" aria-label={label} data-testid="task-evidence">
      <header className="task-evidence__head">
        <BadgeCheck size={13} aria-hidden />
        <Eyebrow tone="steel">{label}</Eyebrow>
      </header>
      {handoff !== undefined && handoff.trim() !== "" ? <p className="task-evidence__handoff">{handoff}</p> : null}
      {groups.length > 0 ? (
        <div className="task-evidence__chips" aria-label="Artifacts cited">
          {groups.map((group) => (
            <EvidenceArtifacts key={group.nodeId} canvasName={canvasName} nodeId={group.nodeId} artifactIds={group.artifactIds} />
          ))}
        </div>
      ) : null}
      {commits.length > 0 ? (
        <p className="task-evidence__line">
          Commits{" "}
          {commits.map((sha) => (
            <code key={sha} title={sha}>
              {shortCommit(sha)}
            </code>
          ))}
        </p>
      ) : null}
      {claims.length > 0 ? (
        <ul className="task-evidence__list" aria-label="Claims">
          {claims.map((claim) => (
            <li key={claim.ruleId}>{claim.text}</li>
          ))}
        </ul>
      ) : null}
      {waivers.length > 0 ? (
        <ul className="task-evidence__list" aria-label="Waived">
          {waivers.map((waiver) => (
            <li key={waiver.ruleId}>Waived: {waiver.reason}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
