import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { claimFocus } from "../../lib/focus-ownership";
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

/** The sidebar whose toggle was just pressed: the toggle that shows next takes the keyboard. */
let toggled: string | null = null;

function SidebarToggle({ label, collapsed }: { readonly label: string; readonly collapsed: boolean }) {
  // One fixed name and a state, not a name that changes with the state.
  return (
    <IconButton
      data-sidebar-toggle=""
      aria-label="Sidebar"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      size="sm"
      aria-expanded={!collapsed}
      onClick={() => {
        toggled = label;
        setSidebarCollapsed(label, !collapsed);
      }}
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
 * Widths: sidebar 220 to 280px, rail 260 to 320px, main takes the rest. A
 * `narrow` sidebar (176 to 208px) is for a list of titles beside a main pane
 * that wants the room, like an open artifact. In a narrow container (under
 * 56rem) the rail drops below the main pane instead of squeezing it. Each
 * pane scrolls on its own; the layout itself never does. It fills its
 * parent, so the parent gives it a height.
 *
 * The rail can collapse too: `railCollapsed` keeps it a 40px edge on the
 * right at every width, never dropped below, and the caller fills that edge
 * with what the rail is worth at a glance (a count, who took part). The
 * caller owns the state; TwoPane only gives the edge its column.
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
  sidebarWidth,
  rail,
  railLabel,
  railCollapsed = false,
  mainLabel,
  children,
}: {
  readonly sidebar: ReactNode;
  readonly sidebarLabel: string;
  /** `narrow` gives the main pane the room; titles in the list ellipsize. */
  readonly sidebarWidth?: "narrow";
  readonly rail?: ReactNode;
  /** Required with `rail`. */
  readonly railLabel?: string;
  /** The rail is a thin edge; `rail` is what the edge shows. */
  readonly railCollapsed?: boolean;
  readonly mainLabel: string;
  readonly children: ReactNode;
}) {
  const collapsed = useSidebarCollapsed(sidebarLabel);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // The press hid the toggle it was made on; the keyboard follows to the one
  // that is showing now, so it does not fall to the page.
  useEffect(() => {
    if (toggled !== sidebarLabel) return;
    toggled = null;
    const next = (collapsed ? stripRef.current : bodyRef.current)?.querySelector<HTMLElement>("[data-sidebar-toggle]");
    claimFocus(next, "gesture", { preventScroll: true });
  }, [collapsed, sidebarLabel]);
  return (
    <div
      className="two-pane"
      data-rail={rail ? (railCollapsed ? "collapsed" : "true") : undefined}
      data-sidebar={collapsed ? "collapsed" : undefined}
      data-sidebar-width={sidebarWidth}
    >
      <aside className="two-pane__sidebar" aria-label={sidebarLabel}>
        <SidebarContext.Provider value={{ label: sidebarLabel }}>
          <div ref={bodyRef} className="two-pane__sidebar-body" hidden={collapsed}>
            {sidebar}
          </div>
        </SidebarContext.Provider>
        {collapsed ? (
          <div ref={stripRef} className="two-pane__strip">
            <FocusMaximizeButton />
            <SidebarToggle label={sidebarLabel} collapsed />
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
