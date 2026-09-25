import { useEffect, useId, useRef, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ChevronRight } from "lucide-react";
import {
  clearSectionReveal,
  sectionOpen,
  setSectionOpen,
  sidebarSections$,
} from "../../lib/sidebar-sections";

/**
 * SidebarSection — one collapsible block of a side panel. The header is a
 * single button (chevron, eyebrow title, count) so it is keyboard reachable
 * and announces its state; the body sizes to its content and the panel owns
 * the scroll. Collapsed state persists per viewer under `storageKey`.
 *
 * `revealFor` + `sectionKey` let a caller elsewhere ask this section to open
 * and scroll into view (see requestSectionReveal).
 */
export function SidebarSection({
  storageKey,
  title,
  count,
  countTone = "faint",
  meta,
  defaultOpen = true,
  revealFor,
  sectionKey,
  testId,
  children,
}: {
  readonly storageKey: string;
  readonly title: string;
  readonly count?: number;
  /** Amber when the count is waiting on the operator. */
  readonly countTone?: "faint" | "amber" | "crimson";
  /** Short trailing text after the count, e.g. "2 unread". */
  readonly meta?: string;
  readonly defaultOpen?: boolean;
  readonly revealFor?: string;
  readonly sectionKey?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const bodyId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const open = sectionOpen(storageKey, defaultOpen, use$(sidebarSections$.open));
  const reveal = use$(sidebarSections$.reveal);

  useEffect(() => {
    if (!reveal || revealFor === undefined || sectionKey === undefined) return;
    if (reveal.nodeId !== revealFor || reveal.section !== sectionKey) return;
    setSectionOpen(storageKey, true);
    clearSectionReveal();
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [reveal, revealFor, sectionKey, storageKey]);

  return (
    <section
      ref={rootRef}
      className={`sidebar-section${open ? " sidebar-section--open" : ""}`}
      aria-label={title}
      data-testid={testId}
      data-section={sectionKey}
    >
      <button
        type="button"
        className="sidebar-section__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setSectionOpen(storageKey, !open)}
      >
        <ChevronRight size={12} strokeWidth={2} className="sidebar-section__chevron" aria-hidden />
        <span className="sidebar-section__title">{title}</span>
        {count !== undefined && count > 0 ? (
          <span className={`sidebar-section__count sidebar-section__count--${countTone}`}>{count}</span>
        ) : null}
        {meta ? <span className="sidebar-section__meta">{meta}</span> : null}
      </button>
      {open ? (
        <div id={bodyId} className="sidebar-section__body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
