import { isResourceAttachment, type AgentSignalAttachment, type AgentSignalResourceAttachment } from "@shared/agent-signals";
import type { Node } from "@shared/model";
import { asNodeId } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/work-ids";
import { useArtifactWhereItIs } from "../../lib/artifact-where";
import { openWorkDetail } from "../../lib/work-detail-open";
import { useCanvas } from "../../lib/use-model";
import { ResourceChip } from "../ui";

/**
 * The tasks and artifacts a signal is about, as chips that open them (0.10
 * plan 03 section 6). Files and the rest are previews (PreviewedMarkdown);
 * these never are. A chip names its item by the agent's caption, else its own
 * title; an artifact is found by its id wherever it is now, its node only a
 * hint (0.11.1, 10), so one moved since the signal was raised still opens and
 * is named where it is. One whose item is gone is drawn unavailable and does
 * not open. `beforeOpen` lets the caller step aside first (the feed closes).
 */
export function SignalResourceChips({
  canvasName,
  attachments,
  beforeOpen,
}: {
  readonly canvasName: string;
  readonly attachments: ReadonlyArray<AgentSignalAttachment> | undefined;
  readonly beforeOpen?: () => void;
}) {
  const nodes = useCanvas(canvasName).nodes;
  const resources = (attachments ?? []).filter(isResourceAttachment);
  if (resources.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tasks and artifacts this is about" data-testid="signal-resource-chips">
      {resources.map((attachment, index) => (
        <li key={`${index}:${attachment.kind}:${attachment.nodeId}:${attachment.kind === "task" ? attachment.taskId : attachment.artifactId}`}>
          {attachment.kind === "task" ? (
            <TaskChip attachment={attachment} nodes={nodes} beforeOpen={beforeOpen} />
          ) : (
            <ArtifactChip canvasName={canvasName} attachment={attachment} nodes={nodes} beforeOpen={beforeOpen} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** A task: its board is its home, and the chip opens the task on it. */
function TaskChip({
  attachment,
  nodes,
  beforeOpen,
}: {
  readonly attachment: Extract<AgentSignalResourceAttachment, { readonly kind: "task" }>;
  readonly nodes: ReadonlyMap<NodeId, Node>;
  readonly beforeOpen?: () => void;
}) {
  const nodeId = asNodeId(attachment.nodeId);
  const node = nodes.get(nodeId);
  return (
    <ResourceChip
      kind="task"
      label={attachment.caption ?? (node ? titleOf(node) : attachment.nodeId)}
      missing={node === undefined}
      onOpen={() => {
        beforeOpen?.();
        openWorkDetail(nodeId, { itemId: attachment.taskId });
      }}
    />
  );
}

/**
 * An artifact, by its id: its title names the chip when the agent gave no
 * caption, and it opens where it is now, even after a move.
 */
function ArtifactChip({
  canvasName,
  attachment,
  nodes,
  beforeOpen,
}: {
  readonly canvasName: string;
  readonly attachment: Extract<AgentSignalResourceAttachment, { readonly kind: "artifact" }>;
  readonly nodes: ReadonlyMap<NodeId, Node>;
  readonly beforeOpen?: () => void;
}) {
  const hint = asNodeId(attachment.nodeId);
  const artifactId = attachment.artifactId as ItemId;
  // Undefined until its first read lands: the hint's node stands until then.
  const where = useArtifactWhereItIs(canvasName, hint, artifactId);
  const nodeId = where?.nodeId ?? hint;
  const node = nodes.get(nodeId);
  const artifact = where?.heads.find((head) => head.artifact.artifactId === artifactId)?.artifact;
  return (
    <ResourceChip
      kind="artifact"
      artifactType={artifact?.type}
      label={attachment.caption ?? artifact?.title ?? (node ? titleOf(node) : attachment.nodeId)}
      missing={node === undefined}
      onOpen={() => {
        beforeOpen?.();
        openWorkDetail(nodeId, { itemId: artifactId });
      }}
    />
  );
}
