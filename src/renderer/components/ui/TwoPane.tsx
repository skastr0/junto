import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Eyebrow } from "./Eyebrow";
import { FocusMaximizeButton } from "./FocusWindow";
import { IconButton } from "./IconButton";
import "./two-pane.css";

// --- sidebar collapse (session memory, by sidebar label) ----------------------
//
// Kept outside the component: Artifacts mounts a different TwoPane for the
// empty pane and for a selected artifact, and the sidebar must stay as the
// operator left it across them.

const collapsedSidebars = new Set<string>();
const collapseListeners = new Set<() => void>();

const setSidebarCollapsed = (label: string, collapsed: boolean): void => {
  if (collapsed === collapsedSidebars.has(label)) return;
  if (collapsed) collapsedSidebars.add(label);
  else collapsedSidebars.delete(label);
  for (const listener of collapseListeners) listener();
};

const useSidebarCollapsed = (label: string): boolean =>
  useSyncExternalStore(
    (listener) => {
      collapseListeners.add(listener);
      return () => collapseListeners.delete(listener);
    },
    () => collapsedSidebars.has(label),
  );

/** What the header of a TwoPane sidebar needs to offer its own collapse. */
const SidebarContext = createContext<{ readonly label: string } | null>(null);

function SidebarToggle({ label, collapsed }: { readonly label: string; readonly collapsed: boolean }) {
  const name = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <IconButton
      aria-label={name}
      title={name}
      size="sm"
      aria-expanded={!collapsed}
      onClick={() => setSidebarCollapsed(label, !collapsed)}
    >
      {collapsed ? <PanelLeftOpen size={14} aria-hidden /> : <PanelLeftClose size={14} aria-hidden />}
    </IconButton>
  );
}

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
 * The sidebar collapses to a thin strip. The `PaneHeader` inside it carries
 * the toggle (and the modal's maximize), and the strip carries them while it
 * is collapsed. The sidebar stays mounted, only hidden, so a search or a
 * half-typed form in it survives. Collapsing is remembered for the session by
 * `sidebarLabel`.
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
  const collapsed = useSidebarCollapsed(sidebarLabel);
  return (
    <div
      className="two-pane"
      data-rail={rail ? "true" : undefined}
      data-sidebar={collapsed ? "collapsed" : undefined}
    >
      <aside className="two-pane__sidebar" aria-label={sidebarLabel}>
        <SidebarContext.Provider value={{ label: sidebarLabel }}>
          <div className="two-pane__sidebar-body" hidden={collapsed}>
            {sidebar}
          </div>
        </SidebarContext.Provider>
        {collapsed ? (
          <div className="two-pane__strip">
            <SidebarToggle label={sidebarLabel} collapsed />
            <FocusMaximizeButton />
          </div>
        ) : null}
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

/**
 * The 36px header of a pane: an eyebrow on the left, the pane's actions on the
 * right. In the sidebar of a TwoPane it also ends with the sidebar's own
 * controls: maximize (inside a focus modal that can grow) and collapse.
 */
export function PaneHeader({ eyebrow, actions }: { readonly eyebrow: ReactNode; readonly actions?: ReactNode }) {
  const sidebar = useContext(SidebarContext);
  return (
    <header className="pane-header">
      <Eyebrow tone="steel">{eyebrow}</Eyebrow>
      {actions || sidebar ? (
        <div className="pane-header__actions">
          {actions}
          {sidebar ? (
            <>
              <FocusMaximizeButton />
              <SidebarToggle label={sidebar.label} collapsed={false} />
            </>
          ) : null}
        </div>
      ) : null}
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
