import { useEffect, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { asNodeId } from "@shared/physics/schema";
import type { CompletionEvidence } from "@shared/work-model";
import { artifactsSource, type ArtifactsSource } from "../../lib/artifacts-source";
import { openWorkDetail } from "../../lib/work-detail-open";
import { Eyebrow, ResourceChip } from "../ui";
import { evidenceGroups, hasEvidence, shortCommit } from "./task-evidence-model";

type Heads =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly heads: Awaited<ReturnType<ArtifactsSource["list"]>> };

/**
 * One Artifacts node's artifacts, read: loading until the first read lands,
 * failed when it did not (kept apart from an artifact that is gone), ready
 * with what it holds. Read again whenever main says they changed.
 */
const useEvidenceHeads = (canvasName: string, nodeId: string): Heads => {
  const [heads, setHeads] = useState<Heads>({ state: "loading" });
  useEffect(() => {
    let live = true;
    let latest = 0;
    setHeads({ state: "loading" });
    const read = (): void => {
      const mine = ++latest;
      artifactsSource()
        .list(canvasName, asNodeId(nodeId))
        .then((list) => {
          if (live && mine === latest) setHeads({ state: "ready", heads: list });
        })
        .catch(() => {
          // A failed re-read keeps the last good list: real titles never turn into a failure.
          if (live && mine === latest) setHeads((prev) => (prev.state === "ready" ? prev : { state: "failed" }));
        });
    };
    read();
    const off = artifactsSource().onChanged(read);
    return () => {
      live = false;
      off();
    };
  }, [canvasName, nodeId]);
  return heads;
};

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
  const read = useEvidenceHeads(canvasName, nodeId);
  return (
    <>
      {artifactIds.map((id) => {
        // `pending` means a queued command to a screen reader, which this is not.
        if (read.state === "loading") return <ResourceChip key={id} kind="artifact" label="Loading" />;
        // A failed read is not a gone artifact: the artifact may be fine, so it is not called unavailable.
        if (read.state === "failed") return <ResourceChip key={id} kind="artifact" label="Could not be read" />;
        const head = read.heads.find((entry) => entry.artifact.artifactId === id);
        return head === undefined ? (
          <ResourceChip key={id} kind="artifact" label="Gone" missing />
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
