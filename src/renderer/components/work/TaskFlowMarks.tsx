import { useState } from "react";
import {
  ArrowUpRight,
  CircleSlash,
  MessageSquarePlus,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
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
  onReject,
}: {
  readonly glance: ArrivalGlance;
  /** Admission is a live question at this station, so admitted rows say so. */
  readonly gatedStation: boolean;
  readonly pending: boolean;
  readonly onPromote?: (note?: string) => void;
  readonly onReject?: (note?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  if (glance.admission === "claimable") {
    if (!gatedStation) return null;
    return (
      <span className="task-flow-mark" title="Approved, workers can be assigned it">
        <Chip tone="green">Approved</Chip>
      </span>
    );
  }
  if (glance.admission === "held") {
    return (
      <span className="task-flow-mark" title="Baking before workers can be assigned it">
        <Chip tone="steel">
          {glance.countdown ? `Held ${glance.countdown}` : "Held"}
        </Chip>
      </span>
    );
  }
  if (glance.admission === "operator-owned") {
    return (
      <span className="task-flow-mark" title="This station is yours, no worker is assigned here">
        <Chip tone="cyan">Operator owned</Chip>
      </span>
    );
  }
  return (
    <div
      className="task-flow-mark relative"
      title="Waiting for you to approve it into the queue"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Chip tone="violet">Awaiting approval</Chip>
      {onPromote ? (
        <Button
          size="xs"
          variant="chrome"
          disabled={pending}
          title="Approve this arrival so workers can be assigned it"
          data-testid="task-flow-promote"
          onClick={() => onPromote()}
        >
          Approve
        </Button>
      ) : null}
      {onReject ? (
        <Button
          size="xs"
          variant="danger"
          disabled={pending}
          title="Reject this arrival"
          data-testid="task-flow-reject"
          onClick={() => onReject()}
        >
          Reject
        </Button>
      ) : null}
      {onPromote && onReject ? (
        <IconButton
          size="sm"
          tone={noteOpen ? "accent" : "default"}
          disabled={pending}
          aria-label={noteOpen ? "Close arrival note" : "Add context to this decision"}
          title={noteOpen ? "Close note" : "Add context before deciding"}
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((current) => !current)}
        >
          {noteOpen ? <X size={12} /> : <MessageSquarePlus size={12} />}
        </IconButton>
      ) : null}
      {noteOpen && onPromote && onReject ? (
        <ArrivalNoteComposer
          note={note}
          pending={pending}
          onNoteChange={setNote}
          onCancel={() => {
            setNote("");
            setNoteOpen(false);
          }}
          onPromote={() => {
            onPromote(note.trim());
            setNote("");
            setNoteOpen(false);
          }}
          onReject={() => {
            onReject(note.trim());
            setNote("");
            setNoteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function ArrivalNoteComposer({
  note,
  pending,
  onNoteChange,
  onCancel,
  onPromote,
  onReject,
}: {
  readonly note: string;
  readonly pending: boolean;
  readonly onNoteChange: (note: string) => void;
  readonly onCancel: () => void;
  readonly onPromote: () => void;
  readonly onReject: () => void;
}) {
  const ready = Boolean(note.trim()) && !pending;
  return (
    <div
      className="absolute right-0 bottom-[calc(100%+6px)] z-20 w-72 rounded-md border border-stroke bg-raise p-2 shadow-xl"
      role="dialog"
      aria-label="Arrival decision context"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label className="mb-1 block text-[9px] uppercase tracking-[0.12em] text-faint">
        Context for this arrival
      </label>
      <Input
        autoFocus
        value={note}
        disabled={pending}
        placeholder="What should the assignee focus on?"
        aria-label="Arrival decision note"
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button size="xs" variant="subtle" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="danger" disabled={!ready} onClick={onReject}>
          Reject with note
        </Button>
        <Button size="xs" variant="primary" disabled={!ready} onClick={onPromote}>
          Approve with note
        </Button>
      </div>
    </div>
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
