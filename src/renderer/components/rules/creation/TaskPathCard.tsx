import { ChevronDown, Flag, GitFork, Timer } from "lucide-react";
import { Chip, type ChipTone } from "../../ui";
import { formatWait } from "../board-settings";
import { admissionLabel, formatDepth, type TaskPathNode } from "./task-path";

const TONE: Readonly<Record<TaskPathNode["admission"], ChipTone>> = {
  auto: "steel",
  approval: "violet",
  operator: "cyan",
};

export function TaskPathCard({
  node,
  expanded,
  ruleCount,
  editable,
  onToggle,
}: {
  readonly node: TaskPathNode;
  readonly expanded: boolean;
  readonly ruleCount: number;
  readonly editable: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="task-path-node"
      data-origin={String(node.origin)}
      data-terminal={String(node.terminal)}
      data-expanded={String(expanded)}
      aria-expanded={expanded}
      aria-controls={expanded ? `task-path-board-${node.nodeId}` : undefined}
      aria-label={`${node.label}, ${formatDepth(node.depth)}`}
      onClick={onToggle}
    >
      <span className="task-path-node__dot" aria-hidden />
      <span className="task-path-node__body">
        <strong>{node.label}</strong>
        <span>
          {node.admission !== "auto" ? (
            <Chip tone={TONE[node.admission]}>
              {admissionLabel(node.admission)}
            </Chip>
          ) : null}
          {node.waitMs ? (
            <Chip tone="steel">
              <Timer size={9} />
              {formatWait(node.waitMs)}
            </Chip>
          ) : null}
          {node.destinations.length > 1 ? (
            <Chip tone="steel">
              <GitFork size={9} />
              {node.destinations.length} ways
            </Chip>
          ) : null}
          {node.terminal ? (
            <span className="task-path-node__terminal" title="Last board">
              <Flag size={10} aria-hidden />
            </span>
          ) : null}
          {ruleCount ? <Chip tone="amber">{ruleCount} rules</Chip> : null}
        </span>
      </span>
      {editable || ruleCount ? <ChevronDown size={12} /> : null}
    </button>
  );
}
