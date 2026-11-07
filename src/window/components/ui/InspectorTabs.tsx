import { useLayoutEffect, useRef } from "react";
import { DIM, HUE, HUE_TEXT, INK, withAlpha } from "../../lib/theme";
import { FOCUS_RING_INSET } from "./focus";

// A tiny, self-contained tab bar primitive for internal panel navigation —
// no CSS import required, so any panel can drop it in. 10px uppercase
// segmented row: ink active on an amber wash, dim inactive, one neutral
// hairline under the row, no coloured edge. Deliberately dumb (controlled active/onSelect) so callers own
// what "tabs" means for their panel.

export interface InspectorTab {
  readonly id: string;
  readonly label: string;
  readonly badge?: number;
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

export function InspectorTabs({
  tabs,
  active,
  onSelect,
  label = "Inspector sections",
}: {
  readonly tabs: ReadonlyArray<InspectorTab>;
  readonly active: string;
  readonly onSelect: (id: string) => void;
  /** Accessible name of the tab row. */
  readonly label?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const count = tabs.length;
  useLayoutEffect(() => {
    const el = row.current;
    if (el === null) return undefined;
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
  }, [count]);
  if (tabs.length === 0) return null;
  return (
    <div ref={row} role="tablist" aria-label={label} className="flex items-end gap-0.5 overflow-x-auto [scrollbar-width:none]" style={{ borderBottom: "1px solid var(--color-overlay-4)" }}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-2 py-1.5 text-label font-medium uppercase tracking-label outline-none transition ${FOCUS_RING_INSET}`}
            style={{
              color: isActive ? INK : DIM,
              background: isActive ? withAlpha(HUE.amber, 0.1) : "transparent",
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span
                className="inline-flex min-w-[14px] items-center justify-center rounded-full px-1 text-label tabular-nums"
                style={{ background: withAlpha(HUE.amber, 0.22), color: HUE_TEXT.amber }}
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
