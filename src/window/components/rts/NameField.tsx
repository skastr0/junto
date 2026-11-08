import { useEffect, useRef, useState } from "react";
import { claimFocus } from "../../lib/focus-ownership";

/**
 * The selected node's name, open for typing in place of the command card
 * title. Focus and select once on mount; Enter or blur commits a changed
 * name, Escape keeps the old one, and the two never both fire. `onDone`
 * gets the key that closed it, so the caller can hand focus back; a blur
 * gives none and leaves focus where the operator put it.
 */
export function NameField({
  initial,
  ariaLabel,
  maxLength,
  onCommit,
  onDone,
}: {
  readonly initial: string;
  readonly ariaLabel: string;
  readonly maxLength?: number;
  readonly onCommit: (name: string) => void;
  readonly onDone: (key?: React.KeyboardEvent) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    claimFocus(ref.current, "open", { select: true });
  }, []);

  const finish = (commit: boolean, key?: React.KeyboardEvent) => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (commit && next !== initial) onCommit(next);
    onDone(key);
  };

  return (
    <input
      ref={ref}
      data-focus-owner="canvas-draft"
      className="rts-cmd__title-input"
      aria-label={ariaLabel}
      maxLength={maxLength}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, event);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false, event);
        }
      }}
    />
  );
}
