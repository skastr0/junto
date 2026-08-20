import { ArrowUpRight, CircleSlash, RotateCcw } from "lucide-react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import type { ArrivalGlance, OutboundGroupKind } from "./task-flow-columns";
import "./task-flow.css";

/**
 * Inbound admission mark. Silent for a claimable arrival — the card already
 * carries its state chip, so only a gate worth acting on speaks up.
 */
export function ArrivalMark({
  glance,
  gatedStation,
  pending,
  onPromote,
}: {
  readonly glance: ArrivalGlance;
  /** Admission is a live question at this station, so admitted rows say so. */
  readonly gatedStation: boolean;
  readonly pending: boolean;
  readonly onPromote?: () => void;
}) {
  if (glance.admission === "claimable") {
    if (!gatedStation) return null;
    return (
      <span className="task-flow-mark" title="Admitted, workers can claim it">
        <Chip tone="green">Admitted</Chip>
      </span>
    );
  }
  if (glance.admission === "held") {
    return (
      <span className="task-flow-mark" title="Baking before workers can claim it">
        <Chip tone="steel">
          {glance.countdown ? `Held ${glance.countdown}` : "Held"}
        </Chip>
      </span>
    );
  }
  if (glance.admission === "operator-owned") {
    return (
      <span className="task-flow-mark" title="This station is yours, no worker claims here">
        <Chip tone="cyan">Operator owned</Chip>
      </span>
    );
  }
  return (
    <span
      className="task-flow-mark"
      title="Waiting for you to admit it into the queue"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Chip tone="violet">Awaiting promotion</Chip>
      {onPromote ? (
        <Button
          size="xs"
          variant="chrome"
          disabled={pending}
          title="Admit this arrival so workers can claim it"
          data-testid="task-flow-promote"
          onClick={onPromote}
        >
          Promote
        </Button>
      ) : null}
    </span>
  );
}

const GROUP_ICON = {
  forwarded: ArrowUpRight,
  returned: RotateCcw,
  closed: CircleSlash,
} as const;

/** Outbound group heading — where this batch of passages went. */
export function OutboundGroupHeader({
  kind,
  station,
  count,
}: {
  readonly kind: OutboundGroupKind;
  /** Destination station name; absent for work that closed here. */
  readonly station?: string;
  readonly count: number;
}) {
  const Icon = GROUP_ICON[kind];
  const label =
    kind === "forwarded"
      ? `To ${station ?? "next station"}`
      : kind === "returned"
        ? `Returned to ${station ?? "previous station"}`
        : "Closed here";
  return (
    <header className="task-flow-group__header" data-kind={kind}>
      <Icon size={11} aria-hidden />
      <span className="task-flow-group__label">{label}</span>
      <span className="task-flow-group__count">{count}</span>
    </header>
  );
}
