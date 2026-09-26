import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import {
  portraitCharacter,
  portraitConfigKey,
  portraitDataUri,
  portraitDetailFor,
  type PortraitConfig,
  type PortraitDetail,
  type PortraitFrame,
} from "@shared/agent-portrait";
import { EXPRESSION_FACES, portraitExpression, type PortraitExpression } from "@shared/portrait-expression";
import type { ThemeMode } from "@shared/theme";
import type { PortraitMood } from "../lib/portrait-mood";
import { bundledCosmeticsRevision } from "../lib/cosmetics";
import { portraitOverrides$, startPortraitOverrides } from "../lib/portrait-overrides-state";
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
//
// Character: the operator's saved override (junto.db portrait_overrides) laid
// over the identity genome. Expression: `mood` (the seat's ring inputs) picks
// one of a finite set of faces, biased by the character's temperament; a new
// face cross-fades over the old one, and not at all under reduced motion.

const CACHE_LIMIT = 4000;
const cache = new Map<string, string>();

/** Cached data URI for an identity at a detail tier, theme, frame, config, and expression. */
export function agentPortraitSrc(
  identity: string,
  mode: ThemeMode,
  detail: PortraitDetail,
  frame: PortraitFrame = "tile",
  config?: PortraitConfig,
  expression: PortraitExpression = "resting",
): string {
  const key = `${bundledCosmeticsRevision}|${frame}|${detail}|${mode}|${expression}|${portraitConfigKey(config)}|${identity}`;
  let src = cache.get(key);
  if (src === undefined) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    src = portraitDataUri({ seed: identity, mode, detail, frame, config, face: EXPRESSION_FACES[expression] });
    cache.set(key, src);
  }
  return src;
}

/** The operator's saved override for a seat (junto.db portrait_overrides), if any. */
export const usePortraitConfig = (identity: string): PortraitConfig | undefined => {
  startPortraitOverrides();
  return use$(() => portraitOverrides$[identity].get()) as PortraitConfig | undefined;
};

const FADE_MS = 220;

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
  /** Explicit character (editor preview). Absent reads the seat's saved override. */
  readonly config?: PortraitConfig;
  /** Seat facts that pick the face. Absent is the resting face. */
  readonly mood?: PortraitMood;
  /** A fixed face, bypassing mood (editor and gallery). */
  readonly expression?: PortraitExpression;
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
  config: configProp,
  mood,
  expression: expressionProp,
}: AgentPortraitProps) {
  const liveMode = use$(themeMode$);
  const mode = theme ?? liveMode;
  const saved = usePortraitConfig(identity);
  const config = configProp ?? saved;
  const expression =
    expressionProp ??
    (mood ? portraitExpression({ ...mood, temperament: portraitCharacter(identity, config).temperament }) : "resting");
  const src = agentPortraitSrc(identity, mode, portraitDetailFor(size), frame, config, expression);
  // Cross-fade: keep the previous face under the new one for one fade.
  const [shown, setShown] = useState({ src, prev: undefined as string | undefined });
  if (shown.src !== src) setShown({ src, prev: shown.src });
  useEffect(() => {
    if (!shown.prev) return;
    const timer = setTimeout(() => setShown((current) => ({ src: current.src, prev: undefined })), FADE_MS + 40);
    return () => clearTimeout(timer);
  }, [shown.prev]);
  const round = frame === "round";
  const radius = round ? "50%" : Math.round(size * 0.26);
  // The badge names the harness; past ~26px it starts to cover the face.
  const badgeSize = Math.min(26, Math.max(11, Math.round(size * (round ? 0.42 : 0.5))));
  const showBadge = badge && harness !== undefined;
  // Round: badge centre on the circle at 45 degrees. Tile: tucked in the corner.
  const badgeOffset = round ? Math.round(size * (0.5 + Math.SQRT1_2 / 2) - badgeSize / 2) : size - badgeSize + 3;
  return (
    <span
      aria-hidden
      className="agent-portrait pointer-events-none relative inline-block shrink-0 select-none"
      data-frame={frame}
      data-expression={expression}
      data-outline={outline ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      style={{ width: size, height: size }}
      {...(title !== undefined ? { title } : {})}
    >
      {shown.prev ? (
        <img
          src={shown.prev}
          width={size}
          height={size}
          alt=""
          draggable={false}
          className="agent-portrait__face agent-portrait__face--prev"
          style={{ borderRadius: radius }}
        />
      ) : null}
      <img
        key={src}
        src={src}
        width={size}
        height={size}
        alt=""
        draggable={false}
        decoding="async"
        className={`agent-portrait__face${shown.prev ? " agent-portrait__face--enter" : ""}`}
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
