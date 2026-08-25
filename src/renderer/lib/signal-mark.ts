/**
 * Shared signal taxonomy for the RTS chrome (region chips + minimap).
 *
 * Two layers, always:
 *   1. Identity — node accent / kind hue (who this is)
 *   2. Signal   — severity-driven accent + symbol (what needs attention)
 *
 * Severity ladder is owned by @shared/region-rollup. This module only maps
 * that ladder (and its reason strings) into a renderable mark. It does not
 * re-derive membership or severity.
 *
 * Tones for blocked/attention/working/idle must match SEVERITY_TONE in
 * activity.ts so HerdrCard spinners, chips, and minimap never disagree.
 */

import type { MemberSeverity, MemberStatus } from "@shared/region-rollup";
import type { CanvasNode } from "@shared/canvas";
import type { ActivityMode, ActivityTone } from "./activity";
import { ACTIVITY_TONE_HEX, SEVERITY_TONE } from "./activity";
import { accentColor, HUE, withAlpha } from "./theme";

export type SignalKind = MemberSeverity;

export interface SignalMark {
  readonly kind: SignalKind;
  readonly tone: ActivityTone | "violet";
  readonly hue: string;
  /** Single-character status mark — chips/minimap read, never prose. */
  readonly symbol: string;
  readonly label: string;
  readonly mode: ActivityMode;
}

const MARK: Readonly<Record<SignalKind, SignalMark>> = {
  blocked: {
    kind: "blocked",
    tone: SEVERITY_TONE.blocked,
    hue: ACTIVITY_TONE_HEX[SEVERITY_TONE.blocked],
    symbol: "⊗",
    label: "blocked",
    mode: "wave",
  },
  attention: {
    kind: "attention",
    tone: SEVERITY_TONE.attention,
    hue: ACTIVITY_TONE_HEX[SEVERITY_TONE.attention],
    symbol: "⚠",
    label: "attention",
    mode: "wave",
  },
  working: {
    kind: "working",
    tone: SEVERITY_TONE.working,
    hue: ACTIVITY_TONE_HEX[SEVERITY_TONE.working],
    symbol: "◉",
    label: "working",
    mode: "wave",
  },
  ready: {
    kind: "ready",
    tone: "green",
    hue: ACTIVITY_TONE_HEX.green,
    // Filled check — finished work waiting to be read, never a warning.
    symbol: "✓",
    label: "ready",
    mode: "pulse",
  },
  parked: {
    kind: "parked",
    tone: "violet",
    hue: HUE.violet,
    symbol: "◌",
    label: "parked",
    mode: "static",
  },
  idle: {
    kind: "idle",
    tone: SEVERITY_TONE.idle,
    hue: ACTIVITY_TONE_HEX[SEVERITY_TONE.idle],
    // Empty circle — not a middot. Middot reads as list punctuation next to
    // labels ("- IDLE", "- terminal") and collides with - separators.
    symbol: "○",
    label: "idle",
    mode: "static",
  },
};

export const signalMark = (severity: MemberSeverity | undefined): SignalMark =>
  MARK[severity ?? "idle"];

/** Prefer a more specific label from rollup reasons when present. */
export const signalMarkForMember = (member: Pick<MemberStatus, "severity" | "reasons">): SignalMark => {
  const base = signalMark(member.severity);
  const reason = member.reasons[0];
  if (!reason) return base;
  // Map machine reasons to short aria/tooltips without inventing severity.
  if (reason === "permission:pending") return { ...base, label: "awaiting permission", symbol: "?" };
  if (reason === "session:live") return { ...base, label: "session live" };
  if (reason === "herdr:working") return { ...base, label: "herdr working" };
  if (reason === "herdr:blocked") return { ...base, label: "herdr blocked" };
  if (reason === "herdr:done") return { ...base, label: "herdr done" };
  if (reason === "activity:ready") return { ...base, label: "ready to read" };
  if (reason.startsWith("flag:")) return { ...base, label: reason.slice("flag:".length) };
  if (reason.startsWith("edge:")) return { ...base, label: reason.slice("edge:".length) };
  if (reason === "relay") return { ...base, label: "relayed block" };
  if (reason.startsWith("seed:")) return { ...base, label: "seed block" };
  return base;
};

const KIND_HUE: Readonly<Record<string, string>> = {
  project: HUE.amber,
  agent: HUE.orange,
  orbit: HUE.indigo,
  plugin: HUE.violet,
  station: HUE.cyan,
  skill: HUE.gold,
  watcher: HUE.amber,
  timer: HUE.steel,
  herdr: HUE.orange,
  page: HUE.cyan,
  node: HUE.steel,
};

/** Identity color for a canvas node — accent first, then entity kind. */
export const identityHue = (node: CanvasNode | undefined): string => {
  if (!node) return HUE.steel;
  if (node.color) return accentColor(node.color);
  const entity = node.ether?.entity;
  if (entity?.kind && KIND_HUE[entity.kind]) return KIND_HUE[entity.kind]!;
  if (node.type === "group") return withAlpha(HUE.steel, 0.45);
  return HUE.amber;
};

/**
 * Minimap fill: signal hue when elevated, identity hue when idle.
 * Never paint elevated state as washed steel — idle is identity, not "white".
 */
export const minimapFill = (
  node: CanvasNode | undefined,
  severity: MemberSeverity | undefined,
): string => {
  const mark = signalMark(severity);
  if (mark.kind !== "idle") return mark.hue;
  return identityHue(node);
};

export const activityToneHex = (tone: ActivityTone | "violet"): string =>
  tone === "violet" ? HUE.violet : ACTIVITY_TONE_HEX[tone];
