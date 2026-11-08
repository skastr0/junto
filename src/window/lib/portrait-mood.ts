import type { AgentSignalKind } from "@shared/agent-signals";
import type { ExpressionInput } from "@shared/portrait-expression";
import type { ThreadHealthValue } from "@shared/thread-health";
import { resolveActivityGlyph, type ActivitySpec } from "./activity";

/** Seat facts a portrait's expression reads; temperament comes from the character. */
export type PortraitMood = Omit<ExpressionInput, "temperament">;

/**
 * The seat's mood from the same inputs its ring paints: the ring's activity
 * glyph, the worst open signal, and the thread-health reading. A stale
 * reading no longer moves the face; the seat line still shows it, dimmed.
 */
export function seatPortraitMood(
  activity: ActivitySpec,
  health?: { readonly value?: ThreadHealthValue; readonly healthStale?: boolean },
  signal?: AgentSignalKind,
): PortraitMood {
  return {
    activity: resolveActivityGlyph(activity.mode, activity.tone, activity.glyph),
    ...(signal ? { signal } : {}),
    ...(health?.value && !health.healthStale ? { health: health.value } : {}),
  };
}
