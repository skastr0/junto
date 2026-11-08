import type { ReactNode } from "react";
import "./region-keys.css";

/**
 * One key of the bottom bar's region strip: an icon, a word for what it
 * opens, and a word for whether that thing is set. The set is small (briefing,
 * folder paths, environment), so each key can afford to say what it is; a
 * bare 12px icon among other icons was easy to miss.
 *
 * Two states, never mixed: "set" colours the icon and the state word; open
 * is the pressed look, and only while the key's screen is open.
 */
export function RegionKey({
  caption,
  name,
  set,
  open,
  testId,
  onClick,
  children,
}: {
  /** The word under the icon. */
  readonly caption: string;
  /** The key's full name, for the tooltip and assistive tech. */
  readonly name: string;
  readonly set: boolean;
  readonly open: boolean;
  readonly testId?: string;
  readonly onClick: () => void;
  /** The icon. */
  readonly children: ReactNode;
}) {
  const state = set ? "set" : "none yet";
  return (
    <button
      type="button"
      className="rts-region-key"
      aria-label={name}
      aria-pressed={open}
      title={`${name}: ${state}`}
      data-state={set ? "set" : "unset"}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="rts-region-key__icon" aria-hidden>
        {children}
      </span>
      <span className="rts-region-key__caption">{caption}</span>
      <span className="rts-region-key__state">{state}</span>
    </button>
  );
}
