import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { claimFocus } from "../../lib/focus-ownership";
import { DIM, HUE, HUE_TEXT, INK, withAlpha } from "../../lib/theme";
import { FOCUS_RING_INSET, HIT_24 } from "./focus";

// A tiny, self-contained tab bar primitive for internal panel navigation —
// no CSS import required, so any panel can drop it in. 10px uppercase
// segmented row: ink active on an amber wash, dim inactive, one neutral
// hairline under the row, no coloured edge. Deliberately dumb (controlled active/onSelect) so callers own
// what "tabs" means for their panel.
//
// Two forms. `panel` is the row at the top of a panel, as above. `chrome` is
// the same tabs as one bordered pill the height of an xs Button, for a header
// beside buttons: no hairline, no scroll, no fade, and no edge on the shown
// tab either.

export interface InspectorTab {
  readonly id: string;
  readonly label: string;
  /** What waits behind the tab, as the unread pill; nothing is drawn at zero. */
  readonly badge?: number;
  /**
   * The tab's whole name, where the label alone does not say it (what a count
   * counts): what a screen reader says for the tab, and the hover line. With
   * it the unread pill is for the eye only, so the count is never said as a
   * bare number.
   */
  readonly title?: string;
}

/** How far a cut row fades at the edge that has more behind it. */
const FADE_PX = 16;

/**
 * A row wider than its box scrolls, its scrollbar hidden, so the edge that has
 * more behind it fades out: a cut tab says there is more, and a row that fits
 * is left as it is. Set on the element itself, so scrolling renders nothing.
 */
const fadeEdges = (row: HTMLElement): void => {
  const more = row.scrollWidth - row.clientWidth > 1;
  const start = more && row.scrollLeft > 1;
  const end = more && row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
  const stops = [start ? `transparent, black ${FADE_PX}px` : "black", end ? `black calc(100% - ${FADE_PX}px), transparent` : "black"];
  row.style.maskImage = start || end ? `linear-gradient(to right, ${stops.join(", ")})` : "";
};

const ROW = {
  panel: "flex items-end gap-0.5 overflow-x-auto [scrollbar-width:none]",
  // The chrome Button's look round the pair. Nothing clips: each half keeps
  // its 24px hit area, and rounds its own outer corners inside the border,
  // on the same radius token as the pill.
  chrome: "inline-flex shrink-0 items-stretch rounded-sm border border-stroke bg-ink/[0.04]",
} as const;

const TAB = {
  panel: `relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-2 py-1.5 text-label font-medium uppercase tracking-label outline-none transition ${FOCUS_RING_INSET}`,
  // The xs Button's box and type, so the pill stands exactly as tall as one.
  chrome: `flex items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5 text-label font-medium uppercase tracking-label outline-none transition-colors first:rounded-l-sm last:rounded-r-sm ${FOCUS_RING_INSET} ${HIT_24}`,
} as const;

export function InspectorTabs({
  tabs,
  active,
  onSelect,
  label = "Inspector sections",
  frame = "panel",
  controls,
  testId,
}: {
  readonly tabs: ReadonlyArray<InspectorTab>;
  readonly active: string;
  readonly onSelect: (id: string) => void;
  /** Accessible name of the tab row. */
  readonly label?: string;
  /** `chrome` is the header form: one pill the height of an xs Button. */
  readonly frame?: "panel" | "chrome";
  /** The id of the element the tabs switch: every tab names it as what it controls. */
  readonly controls?: string;
  /** Each tab is found as `<testId>-<tab id>`. */
  readonly testId?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const count = tabs.length;
  useLayoutEffect(() => {
    const el = row.current;
    // The header form never scrolls, so it has no edge to fade.
    if (el === null || frame === "chrome") return undefined;
    const update = (): void => fadeEdges(el);
    update();
    el.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver !== "function") return () => el.removeEventListener("scroll", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [count, frame]);
  if (tabs.length === 0) return null;
  // One stop in the Tab order, the shown tab (the first when none is shown):
  // Tab leaves the row for what it shows, Left and Right move within it.
  const stop = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id;
  // Left and Right walk the row and show the tab they land on, round the ends.
  // The keyboard stays on the row: what a tab shows is reached with Tab.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab === undefined || next === index) return;
    onSelect(tab.id);
    claimFocus(row.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next], "gesture", { event });
  };
  return (
    <div
      ref={row}
      role="tablist"
      aria-label={label}
      className={ROW[frame]}
      style={frame === "panel" ? { borderBottom: "1px solid var(--color-overlay-4)" } : undefined}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={controls}
            tabIndex={tab.id === stop ? 0 : -1}
            aria-label={tab.title}
            title={tab.title}
            data-testid={testId === undefined ? undefined : `${testId}-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={frame === "chrome" && !isActive ? `${TAB.chrome} hover:bg-ink/10` : TAB[frame]}
            style={
              frame === "chrome" && !isActive
                ? { color: DIM }
                : { color: isActive ? INK : DIM, background: isActive ? withAlpha(HUE.amber, 0.1) : "transparent" }
            }
          >
            {tab.label}
            {tab.badge ? (
              // The unread pill: a minimum width and no height of its own, so
              // it sits on the label's line and never makes a tab taller.
              <span
                aria-hidden={tab.title === undefined ? undefined : true}
                className="inline-flex min-w-[15px] items-center justify-center rounded-full px-1 font-mono text-label font-semibold tabular-nums"
                style={{ background: HUE_TEXT.amber, color: "var(--color-ground)" }}
              >
                {tab.badge > 99 ? "99+" : tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
