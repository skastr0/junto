// The glance colour of an AI reading, free of the health store; thread-health.ts
// re-exports it.
import type { ThreadHealthTone } from "@shared/thread-health";
import type { StatusTone } from "../components/ui/StatusDot";

/** The three hues health may use; a subset of both the StatusDot and Chip tones. */
export type ThreadHealthHue = Extract<StatusTone, "amber" | "steel" | "green">;

/** Glance colour per tone. Never crimson: that hue belongs to declared blockers. */
export const THREAD_HEALTH_STATUS_TONE: Readonly<Record<ThreadHealthTone, ThreadHealthHue>> = {
  trouble: "amber",
  waiting: "amber",
  steady: "steel",
  good: "green",
};
