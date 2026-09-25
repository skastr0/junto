import { use$ } from "@legendapp/state/react";
import {
  portraitDataUri,
  portraitDetailFor,
  type PortraitDetail,
  type PortraitFrame,
} from "@shared/agent-portrait";
import type { ThemeMode } from "@shared/theme";
import { themeMode$ } from "../lib/theme-mode";
import { HarnessMark } from "./HarnessMark";
import "./AgentPortrait.css";

// Generated portrait for an agent seat: a critter seeded by the seat's stable
// node id, with the harness riding as a small badge so the brand stays
// legible. The SVG is built once per identity + theme + detail tier + frame
// and served as a data-URI <img>: one DOM element per portrait, rasterized
// and cached by the browser, never regenerated per frame. Purely
// presentational (pointer-events none) so the seat around it owns gestures.
//
// Seat contract (the activity ring is drawn by the seat, not here):
//   <AgentPortrait identity={node.id} size={40} frame="round" outline={false} />
// The box is exactly size x size; a round portrait fills the inscribed circle,
// so a ring drawn outside that box never covers the face. The badge sits on
// the circle's lower-right edge (45 degrees) and may overlap the ring.

const CACHE_LIMIT = 4000;
const cache = new Map<string, string>();

/** Cached data URI for an identity at a detail tier, theme, and frame. */
export function agentPortraitSrc(
  identity: string,
  mode: ThemeMode,
  detail: PortraitDetail,
  frame: PortraitFrame = "tile",
): string {
  const key = `${frame}|${detail}|${mode}|${identity}`;
  let src = cache.get(key);
  if (src === undefined) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    src = portraitDataUri({ seed: identity, mode, detail, frame });
    cache.set(key, src);
  }
  return src;
}

export interface AgentPortraitProps {
  /** Stable seat identity, the canvas node id. Never the display name. */
  readonly identity: string;
  /** Rendered box in CSS px; picks the detail tier. */
  readonly size: number;
  /** Paint for a specific mode; defaults to the live theme. */
  readonly theme?: ThemeMode;
  /** `tile` rounded square (default) or `round` porthole for ringed seats. */
  readonly frame?: PortraitFrame;
  /** Managed harness id; drives the badge. Absent means no badge. */
  readonly harness?: string;
  readonly badge?: boolean;
  /** Hairline edge on the face. Seats that draw a ring pass false. */
  readonly outline?: boolean;
  readonly focused?: boolean;
  readonly title?: string;
}

export function AgentPortrait({
  identity,
  size,
  theme,
  frame = "tile",
  harness,
  badge = true,
  outline = true,
  focused = false,
  title,
}: AgentPortraitProps) {
  const liveMode = use$(themeMode$);
  const mode = theme ?? liveMode;
  const src = agentPortraitSrc(identity, mode, portraitDetailFor(size), frame);
  const round = frame === "round";
  const radius = round ? "50%" : Math.round(size * 0.26);
  const badgeSize = Math.max(11, Math.round(size * (round ? 0.42 : 0.5)));
  const showBadge = badge && harness !== undefined;
  // Round: badge centre on the circle at 45 degrees. Tile: tucked in the corner.
  const badgeOffset = round ? Math.round(size * (0.5 + Math.SQRT1_2 / 2) - badgeSize / 2) : size - badgeSize + 3;
  return (
    <span
      aria-hidden
      className="agent-portrait pointer-events-none relative inline-block shrink-0 select-none"
      data-frame={frame}
      data-outline={outline ? "true" : undefined}
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
          style={{
            left: badgeOffset,
            top: badgeOffset,
            borderRadius: Math.round((badgeSize * 8) / 28) + 1.5,
          }}
        >
          <HarnessMark agent={harness} size={badgeSize} title={false} />
        </span>
      ) : null}
    </span>
  );
}
