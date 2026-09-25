import { use$ } from "@legendapp/state/react";
import { portraitDataUri, portraitDetailFor, type PortraitDetail } from "@shared/agent-portrait";
import type { ThemeMode } from "@shared/theme";
import { themeMode$ } from "../lib/theme-mode";
import { HarnessMark } from "./HarnessMark";
import "./AgentPortrait.css";

// Generated portrait for an agent seat: a critter seeded by the seat's stable
// node id, with the harness riding as a small badge so the brand stays
// legible. The SVG is built once per seed + theme + detail tier and served as
// a data-URI <img>: one DOM element per portrait, rasterized and cached by the
// browser, never regenerated per frame. Purely presentational (pointer-events
// none) so the card beside it owns the gestures, like HarnessMark.

const CACHE_LIMIT = 4000;
const cache = new Map<string, string>();

/** Cached data URI for a seed at a detail tier in a theme mode. */
export function agentPortraitSrc(seed: string, mode: ThemeMode, detail: PortraitDetail): string {
  const key = `${detail}|${mode}|${seed}`;
  let src = cache.get(key);
  if (src === undefined) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    src = portraitDataUri({ seed, mode, detail });
    cache.set(key, src);
  }
  return src;
}

export function AgentPortrait({
  seed,
  harness,
  size,
  focused = false,
  badge = true,
  title,
}: {
  /** Stable seat identity, the canvas node id. */
  readonly seed: string;
  /** Managed harness id; drives the badge. Absent means no badge. */
  readonly harness?: string;
  readonly size: number;
  readonly focused?: boolean;
  readonly badge?: boolean;
  readonly title?: string;
}) {
  const mode = use$(themeMode$);
  const src = agentPortraitSrc(seed, mode, portraitDetailFor(size));
  const radius = Math.round(size * 0.26);
  const badgeSize = Math.max(11, Math.round(size * 0.5));
  const showBadge = badge && harness !== undefined;
  return (
    <span
      aria-hidden
      className="agent-portrait pointer-events-none relative inline-block shrink-0 select-none"
      data-focused={focused ? "true" : undefined}
      style={{ width: size, height: size }}
      {...(title !== undefined ? { title } : {})}
    >
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        draggable={false}
        decoding="async"
        className="agent-portrait__face"
        style={{ borderRadius: radius }}
      />
      {showBadge ? (
        <span
          className="agent-portrait__badge"
          style={{ borderRadius: Math.round((badgeSize * 8) / 28) + 1.5 }}
        >
          <HarnessMark agent={harness} size={badgeSize} title={false} />
        </span>
      ) : null}
    </span>
  );
}
