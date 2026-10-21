import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";
import "./two-pane.css";

/**
 * TwoPane: the layout of the Artifacts and Automations nodes (05, 07): a
 * sidebar list of the node's things, the selected one in the main pane, and
 * optionally a rail on the right (the comments rail of an artifact). One
 * layout so the two nodes read as one family.
 *
 * Widths: sidebar 220 to 280px, rail 260 to 320px, main takes the rest. In a
 * narrow container (under 56rem) the rail drops below the main pane instead
 * of squeezing it. Each pane scrolls on its own; the layout itself never
 * does. It fills its parent, so the parent gives it a height.
 *
 * Every pane needs a name for assistive tech, so each label is required.
 * Fill the sidebar with `PaneHeader` and rows (`ListRow`, with `pending` for
 * a queued item), and an unselected main pane with `PaneEmpty`.
 */
export function TwoPane({
  sidebar,
  sidebarLabel,
  rail,
  railLabel,
  mainLabel,
  children,
}: {
  readonly sidebar: ReactNode;
  readonly sidebarLabel: string;
  readonly rail?: ReactNode;
  /** Required with `rail`. */
  readonly railLabel?: string;
  readonly mainLabel: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="two-pane" data-rail={rail ? "true" : undefined}>
      <aside className="two-pane__sidebar" aria-label={sidebarLabel}>
        {sidebar}
      </aside>
      <section className="two-pane__main" aria-label={mainLabel}>
        {children}
      </section>
      {rail ? (
        <aside className="two-pane__rail" aria-label={railLabel}>
          {rail}
        </aside>
      ) : null}
    </div>
  );
}

/** The 36px header of a pane: an eyebrow on the left, the pane's actions on the right. */
export function PaneHeader({ eyebrow, actions }: { readonly eyebrow: ReactNode; readonly actions?: ReactNode }) {
  return (
    <header className="pane-header">
      <Eyebrow tone="steel">{eyebrow}</Eyebrow>
      {actions ? <div className="pane-header__actions">{actions}</div> : null}
    </header>
  );
}

/** Nothing selected, or nothing yet: one quiet sentence and the way to start. */
export function PaneEmpty({
  glyph,
  title,
  hint,
  action,
}: {
  readonly glyph?: ReactNode;
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="pane-empty">
      {glyph ? (
        <div className="pane-empty__glyph" aria-hidden>
          {glyph}
        </div>
      ) : null}
      <p className="pane-empty__title">{title}</p>
      {hint ? <p className="pane-empty__hint">{hint}</p> : null}
      {action ? <div className="pane-empty__action">{action}</div> : null}
    </div>
  );
}
