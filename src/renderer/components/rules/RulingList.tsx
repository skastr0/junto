import { X } from "lucide-react";
import type { Ruling } from "@shared/work-model";
import { IconButton } from "../ui";

// Rulings are pinned precedents: the operator's answer to one escalation,
// kept as standing context for every seat inside the region. Authoring here
// is read and unpin only — pinning happens where the answer is given.

const pinnedLabel = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export function RulingList({
  rulings,
  onUnpin,
}: {
  readonly rulings: ReadonlyArray<Ruling>;
  readonly onUnpin: (id: string) => void;
}) {
  if (rulings.length === 0) return null;
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">rulings</div>
      <div className="inspector-detail mt-1">
        Answers pinned from escalations. Seats read them on onboard.
      </div>
      <div className="mt-2 grid gap-1.5" role="list">
        {rulings.map((ruling) => (
          <div
            key={ruling.id}
            role="listitem"
            className="flex items-start gap-1.5 rounded-[4px] border border-stroke bg-inset/50 px-2 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[11px] leading-snug text-ink">{ruling.text}</div>
              <div className="mt-1 text-[9px] tracking-[0.1em] text-faint uppercase">
                {pinnedLabel(ruling.pinnedAt)}
              </div>
            </div>
            <IconButton
              size="sm"
              tone="danger"
              aria-label="Unpin ruling"
              title="Unpin this ruling"
              onClick={() => onUnpin(ruling.id)}
            >
              <X size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
