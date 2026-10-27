import { useMemo, useState } from "react";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import type { MentionCandidate } from "../../lib/mention-draft";
import { candidateKey, triggerOf } from "../../lib/mention-draft";
import { Combobox } from "../ui/Combobox";
import { ResourceGlyphMark, mentionMark } from "../ui/ResourceChip";

/** A label without its trigger, lowercased: what typing matches. */
const nameOf = (candidate: MentionCandidate): string => candidate.label.replace(/^[@#]/u, "").toLowerCase();

/**
 * The candidates a typed query keeps: seats, tasks and artifacts alike, those whose name starts
 * with it first, then those that contain it. A leading @ or # keeps that trigger's kinds only, as
 * in every composer. An empty query keeps them all, in the order given.
 */
export const pickCandidates = (candidates: ReadonlyArray<MentionCandidate>, query: string): ReadonlyArray<MentionCandidate> => {
  const trimmed = query.trim();
  const trigger = trimmed.startsWith("@") ? "@" : trimmed.startsWith("#") ? "#" : undefined;
  const typed = (trigger === undefined ? trimmed : trimmed.slice(1)).toLowerCase();
  if (typed === "" && trigger === undefined) return candidates;
  const own = trigger === undefined ? candidates : candidates.filter((candidate) => triggerOf(candidate.ref) === trigger);
  const starts = own.filter((candidate) => nameOf(candidate).startsWith(typed));
  const contains = own.filter((candidate) => !starts.includes(candidate) && nameOf(candidate).includes(typed));
  return [...starts, ...contains];
};

/** The list opens with the caret in its field: the operator asked for it with @. */
const focusField = (element: HTMLDivElement | null): void => claimFocusOnMount(element?.querySelector("input") ?? null);

/**
 * The pad's @ list: pick a seat, a task or an artifact and it becomes a card where the list was
 * opened. The house typeahead over the composer's own candidates; Escape or a pick closes it.
 */
export function PadCardPicker({
  candidates,
  onPick,
  onClose,
}: {
  readonly candidates: ReadonlyArray<MentionCandidate>;
  readonly onPick: (candidate: MentionCandidate) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const offered = useMemo(() => pickCandidates(candidates, query), [candidates, query]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const activeKey = active !== undefined && offered.some((candidate) => candidateKey(candidate) === active) ? active : offered[0] && candidateKey(offered[0]);
  return (
    <div
      ref={focusField}
      className="pad-card-picker"
      data-testid="pad-card-picker"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <Combobox
        value={query}
        onValueChange={setQuery}
        options={offered}
        optionKey={candidateKey}
        activeKey={activeKey}
        onActiveKeyChange={setActive}
        renderOption={(candidate) => (
          <span className="flex min-w-0 items-center gap-2">
            <ResourceGlyphMark {...mentionMark(candidate.ref)} />
            <span className="truncate">{candidate.label}</span>
            {candidate.detail ? <span className="truncate text-faint">{candidate.detail}</span> : null}
          </span>
        )}
        onCommit={(option) => {
          if (option !== undefined) onPick(option);
        }}
        onOptionClick={onPick}
        aria-label="Put a card on the pad"
        listLabel="Seats, tasks and artifacts"
        placeholder="A seat, a task or an artifact"
        empty={<span className="text-label text-faint">Nothing in reach by that name</span>}
      />
    </div>
  );
}
