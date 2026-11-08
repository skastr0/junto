import { Minus, Plus, ShieldCheck } from "lucide-react";
import { STAMPS_REQUIRED_MAX } from "@shared/task-model";
import { IconButton } from "../ui";
import "./tasks.css";

/**
 * The approvals a new task on this node needs by default (plan 04: "a task
 * node may set a default"). A task arriving by flow starts with it too. This
 * only edits the number; where it is stored is the node's, so the Tasks node
 * hands in `required` (what `stampDefaultOf` answers) and takes the new count.
 */
export function StampDefaultControl({
  required,
  pending = false,
  onChange,
}: {
  readonly required: number;
  readonly pending?: boolean;
  readonly onChange: (required: number) => void;
}) {
  return (
    <div className="stamp-default" data-testid="stamp-default" role="group" aria-label="Approvals a new task needs by default">
      <ShieldCheck size={13} aria-hidden />
      <span>New tasks need</span>
      <IconButton
        aria-label="Default one fewer approval"
        title="Default one fewer approval"
        disabled={pending || required <= 0}
        onClick={() => onChange(required - 1)}
      >
        <Minus size={12} />
      </IconButton>
      <output aria-label="Default approvals">{required}</output>
      <IconButton
        aria-label="Default one more approval"
        title="Default one more approval"
        disabled={pending || required >= STAMPS_REQUIRED_MAX}
        onClick={() => onChange(required + 1)}
      >
        <Plus size={12} />
      </IconButton>
      <span>{required === 1 ? "approval" : "approvals"}</span>
    </div>
  );
}
