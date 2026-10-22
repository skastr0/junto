import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { FeedRegionChip } from "../../lib/operator-feed";
import { regionWordShare } from "../../lib/region-word-ink";
import { accentColor } from "../../lib/theme";
import "./feed-region-strip.css";

/** How much of the chip before the chosen one stays in view, so the strip reads as scrollable. */
const REVEAL_INSET = 32;

/**
 * The region's colours as the phone draws them: a preset or hex is the base,
 * a region with no colour of its own the main accent, the open field steel.
 * Ink, tint and halo mix from the base in feed-region-strip.css. A free hex
 * is no preset tuned per theme, so its words take only as much of it as
 * still reads at 4.5:1 in each theme.
 */
const chipStyle = (chip: FeedRegionChip): CSSProperties => {
  const base = chip.open ? "var(--color-steel)" : accentColor(chip.color);
  if (!base.startsWith("#")) return { "--chip-region": base } as CSSProperties;
  return {
    "--chip-region": base,
    "--chip-share-dark": `${regionWordShare(base, "dark")}%`,
    "--chip-share-bright": `${regionWordShare(base, "bright")}%`,
  } as CSSProperties;
};

/**
 * The Needs you feed's region filter, a strip of chips like the phone's
 * region bar: All first, then each region with its colour, its outer regions
 * and how many wait on the operator there and in its children. A press picks
 * a region; pressing it again, or All, shows everything. The chosen chip
 * scrolls into view with the one before it peeking in. With one region and
 * nothing picked there is nothing to choose, and the strip is not drawn.
 */
export function FeedRegionStrip({
  chips,
  chosen,
  total,
  onPick,
}: {
  readonly chips: ReadonlyArray<FeedRegionChip>;
  /** The chosen chip's key; undefined is All. */
  readonly chosen: string | undefined;
  /** Everything waiting, for All. */
  readonly total: number;
  readonly onPick: (chip: FeedRegionChip | undefined) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = strip.current;
    if (!bar) return;
    const at = [...bar.querySelectorAll<HTMLElement>("[data-chip-key]")].find((chip) => chip.dataset.chipKey === chosen);
    // The strip is the chips' offset parent (feed-region-strip.css).
    const left = at ? at.offsetLeft - REVEAL_INSET : 0;
    const right = at ? at.offsetLeft + at.offsetWidth - bar.clientWidth : 0;
    // Only as far as it takes: a chip already in view leaves the strip where it is.
    if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left);
    else if (right > bar.scrollLeft) bar.scrollLeft = right;
  }, [chosen]);
  const drawn = chips.length >= 2 || chosen !== undefined;
  useEffect(() => {
    const bar = strip.current;
    if (!bar) return;
    // Which edges have chips past them, for the fades in feed-region-strip.css.
    const edges = (): void => {
      bar.dataset.moreStart = String(bar.scrollLeft > 0);
      bar.dataset.moreEnd = String(bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
    };
    // A mouse wheel scrolls the strip sideways, and only the strip; a
    // trackpad's own sideways swipe is left alone. Not passive, so the feed
    // around it does not scroll too.
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaX !== 0 || event.deltaY === 0 || bar.scrollWidth <= bar.clientWidth) return;
      event.preventDefault();
      bar.scrollLeft += event.deltaY;
    };
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(edges) : undefined;
    resized?.observe(bar);
    bar.addEventListener("scroll", edges, { passive: true });
    bar.addEventListener("wheel", onWheel, { passive: false });
    edges();
    return () => {
      resized?.disconnect();
      bar.removeEventListener("scroll", edges);
      bar.removeEventListener("wheel", onWheel);
    };
  }, [drawn, chips]);
  if (!drawn) return null;
  return (
    <div
      ref={strip}
      className="feed-region-strip"
      role="radiogroup"
      aria-label="Filter needs by region"
      data-testid="feed-region-strip"
    >
      <button
        type="button"
        role="radio"
        aria-checked={chosen === undefined}
        aria-label={`All regions${total > 0 ? `, ${total} waiting` : ""}`}
        className="feed-region-strip__all"
        data-testid="feed-region-chip"
        onClick={() => onPick(undefined)}
      >
        <span>All</span>
        {total > 0 ? <span className="feed-region-strip__all-count">{total}</span> : null}
      </button>
      {chips.map((chip) => {
        const where = chip.outer.length > 0 ? `${chip.outer.join(" > ")} > ` : "";
        const selected = chip.key === chosen;
        return (
          <button
            key={chip.key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${where}${chip.label}${chip.count > 0 ? `, ${chip.count} waiting` : ""}`}
            className="feed-region-chip"
            data-open-field={chip.open ? "true" : undefined}
            data-testid="feed-region-chip"
            data-chip-key={chip.key}
            style={chipStyle(chip)}
            title={`${where}${chip.label}`}
            onClick={() => onPick(selected ? undefined : chip)}
          >
            <span className="feed-region-chip__swatch" aria-hidden />
            <span className="feed-region-chip__text">
              {where ? <span className="feed-region-chip__outer">{where}</span> : null}
              <span className="feed-region-chip__label">{chip.label}</span>
            </span>
            {chip.count > 0 ? <span className="feed-region-chip__count">{chip.count > 99 ? "99+" : chip.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
