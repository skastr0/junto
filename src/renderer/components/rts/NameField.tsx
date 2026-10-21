import { useEffect, useRef, useState } from "react";
import { claimFocus } from "../../lib/focus-ownership";

/**
 * The selected node's name, open for typing in place of the command card
 * title. Focus and select once on mount; Enter or blur commits a changed
 * name, Escape keeps the old one, and the two never both fire.
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
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    claimFocus(ref.current, "open", { select: true });
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (commit && next !== initial) onCommit(next);
    onDone();
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
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}
