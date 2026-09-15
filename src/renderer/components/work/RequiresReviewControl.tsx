import { ShieldCheck } from "lucide-react";
import { Button, Chip } from "../ui";
import type { ReviewGate } from "../../lib/crew-review-view";
import "./requires-review.css";

export function RequiresReviewControl({
  gate,
  pending = false,
  editable = false,
  onChange,
}: {
  readonly gate: ReviewGate;
  readonly pending?: boolean;
  readonly editable?: boolean;
  readonly onChange?: (required: boolean) => void;
}) {
  const canWrite = editable && onChange !== undefined && !pending;
  return (
    <section
      className="requires-review"
      data-testid="requires-review-authoring"
      data-required={gate.required ? "true" : "false"}
      data-satisfied={gate.required ? (gate.satisfied ? "true" : "false") : undefined}
      aria-label="Review requirement"
    >
      <div className="requires-review__head">
        <div className="requires-review__copy">
          <span>Review</span>
          <p>
            Completion waits on a distinct reviewer's green verdict for the
            current epoch. A blocking verdict returns the work with a defect.
          </p>
        </div>
        {canWrite ? (
          <Button
            size="xs"
            variant={gate.required ? "primary" : "chrome"}
            aria-pressed={gate.required}
            disabled={pending}
            onClick={() => onChange(!gate.required)}
          >
            <ShieldCheck size={11} />
            {gate.required ? "Required" : "Not required"}
          </Button>
        ) : (
          <Chip tone={gate.required ? "amber" : "steel"}>
            {gate.required ? "required" : "not required"}
          </Chip>
        )}
      </div>
      {gate.required ? (
        <div className="requires-review__gate">
          <Chip tone={gate.satisfied ? "green" : "amber"}>
            {gate.satisfied ? "green on this epoch" : "waiting for green"}
          </Chip>
          <Chip tone="steel">epoch {gate.currentEpoch}</Chip>
          {gate.blocking ? (
            <Chip tone="crimson">blocking on this epoch</Chip>
          ) : null}
        </div>
      ) : (
        <p className="requires-review__empty">
          Author this on the board or the task. The kernel refuses complete
          until a distinct reviewer records green.
        </p>
      )}
    </section>
  );
}
