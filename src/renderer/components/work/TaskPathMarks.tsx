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
import type { IncomingGlance, OutgoingGroupKind } from "./task-path";
import "./task-path.css";
import { claimFocusOnMount } from "../../lib/focus-ownership";

/**
 * Admission mark for submitted tasks. Silent for an Immediate task — the card
 * already carries its state chip, so only a gate worth acting on speaks up.
 */
export function ApprovalMark({
  glance,
  gatedBoard,
  pending,
  onPromote,
}: {
  readonly glance: IncomingGlance;
  /** Admission is a live question at this board, so approved rows say so. */
  readonly gatedBoard: boolean;
  readonly pending: boolean;
  readonly onPromote?: (note?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  if (glance.admission === "claimable") {
    if (!gatedBoard) return null;
    return (
      <span className="task-path-mark" title="Approved, agents can claim it">
        <Chip tone="green">Approved</Chip>
      </span>
    );
  }
  if (glance.admission === "waiting" && glance.countdown !== undefined) {
    return (
      <span className="task-path-mark" title="Waiting before any agent can claim it">
        <Chip tone="steel">Wait {glance.countdown}</Chip>
      </span>
    );
  }
  if (glance.admission === "operator") {
    return (
      <span className="task-path-mark" title="This board is yours, no agent works here">
        <Chip tone="cyan">Me</Chip>
      </span>
    );
  }
  return (
    <div
      className="task-path-mark relative"
      title="Waiting for your approval before agents can claim it"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Chip tone="violet">Awaiting approval</Chip>
      {onPromote ? (
        <Button
          size="xs"
          variant="chrome"
          disabled={pending}
          title="Approve this task so agents can claim it"
          data-testid="task-path-approve"
          onClick={() => onPromote()}
        >
          Approve
        </Button>
      ) : null}
      {onPromote ? (
        <IconButton
          size="sm"
          tone={noteOpen ? "accent" : "default"}
          disabled={pending}
          aria-label={noteOpen ? "Close approval note" : "Add context to this decision"}
          title={noteOpen ? "Close note" : "Add context before deciding"}
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((current) => !current)}
        >
          {noteOpen ? <X size={12} /> : <MessageSquarePlus size={12} />}
        </IconButton>
      ) : null}
      {noteOpen && onPromote ? (
        <ApprovalNoteComposer
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
        />
      ) : null}
    </div>
  );
}

export function ApprovalNoteComposer({
  note,
  pending,
  onNoteChange,
  onCancel,
  onPromote,
}: {
  readonly note: string;
  readonly pending: boolean;
  readonly onNoteChange: (note: string) => void;
  readonly onCancel: () => void;
  readonly onPromote: () => void;
}) {
  const ready = Boolean(note.trim()) && !pending;
  return (
    <div
      className="absolute right-0 bottom-[calc(100%+6px)] z-20 w-72 rounded-md border border-stroke bg-raise p-2 shadow-xl"
      role="dialog"
      aria-label="Approval decision context"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label className="mb-1 block text-[9px] uppercase tracking-[0.12em] text-faint">
        Context for this decision
      </label>
      <Input
        ref={claimFocusOnMount}
        value={note}
        disabled={pending}
        placeholder="What should the next worker focus on?"
        aria-label="Approval decision note"
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button size="xs" variant="subtle" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" disabled={!ready} onClick={onPromote}>
          Approve with note
        </Button>
      </div>
    </div>
  );
}

const GROUP_ICON = {
  "sent-on": ArrowUpRight,
  "sent-back": RotateCcw,
  completed: CircleSlash,
} as const;

/** Outgoing group heading — where this batch of visits went. */
export function OutgoingGroupHeader({
  kind,
  board,
  count,
}: {
  readonly kind: OutgoingGroupKind;
  /** Next or previous board name; absent for work completed here. */
  readonly board?: string;
  readonly count: number;
}) {
  const Icon = GROUP_ICON[kind];
  const label =
    kind === "sent-on"
      ? `Sent on to ${board ?? "next board"}`
      : kind === "sent-back"
        ? `Sent back to ${board ?? "previous board"}`
        : "Completed here";
  return (
    <header className="task-path-group__header" data-kind={kind}>
      <Icon size={11} aria-hidden />
      <span className="task-path-group__label">{label}</span>
      <span className="task-path-group__count">{count}</span>
    </header>
  );
}
