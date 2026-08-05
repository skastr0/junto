import { useEffect, useRef, useState } from "react";
import { INK } from "../../lib/theme";

/**
 * Full-width first-line rename field for node cards.
 *
 * Focus + select once on mount only — a render-time ref that re-selects on
 * every keystroke replaces the whole value with a single character.
 * Enter/blur commits, Escape discards; Enter→blur is coalesced.
 */
export function FirstLineRenameInput({
  initial,
  ariaLabel,
  onCommit,
  onDone,
}: {
  readonly initial: string;
  readonly ariaLabel: string;
  readonly onCommit: (firstLine: string) => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const firedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const finish = (commit: boolean) => {
    if (firedRef.current) return;
    firedRef.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) onCommit(next);
    onDone();
  };

  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel}
      className="nodrag nopan nowheel min-w-0 w-full bg-transparent text-left font-mono text-[14px] font-semibold leading-snug outline-none"
      style={{ color: INK, width: "100%" }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
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
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
