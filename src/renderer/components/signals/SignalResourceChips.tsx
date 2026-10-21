import { isResourceAttachment, type AgentSignalAttachment, type AgentSignalResourceAttachment } from "@shared/agent-signals";
import { titleOf } from "@shared/model/title";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { useCanvas } from "../../lib/use-model";
import { ResourceChip } from "../ui";

/**
 * The tasks and artifacts a signal is about, as chips that open them (0.10
 * plan 03 section 6). Files and the rest are previews (PreviewedMarkdown);
 * these never are. A chip names its item by the agent's caption, else by its
 * node; one whose node is gone is drawn unavailable and does not open.
 * Opening shows the resource's node; `beforeOpen` lets the caller step aside
 * first (the feed closes).
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
  const open = (attachment: AgentSignalResourceAttachment): void => {
    beforeOpen?.();
    activateNodeSurface(attachment.nodeId);
  };
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tasks and artifacts this is about" data-testid="signal-resource-chips">
      {resources.map((attachment, index) => {
        const node = nodes.get(attachment.nodeId);
        const item = attachment.kind === "task" ? attachment.taskId : attachment.artifactId;
        return (
          <li key={`${index}:${attachment.kind}:${attachment.nodeId}:${item}`}>
            <ResourceChip
              kind={attachment.kind}
              label={attachment.caption ?? (node ? titleOf(node) : attachment.nodeId)}
              missing={node === undefined}
              onOpen={() => open(attachment)}
            />
          </li>
        );
      })}
    </ul>
  );
}
