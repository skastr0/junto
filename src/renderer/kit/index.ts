/**
 * The Junto kit: the canvas's seat, ring, portrait, bubble and wire pulse as
 * pure views, and the tour's stage pieces built on them, for the website and
 * docs to draw exactly what the app draws.
 *
 * Nothing here reads the app: no store, no IPC, no canvas camera
 * (tests/kit-purity.test.ts holds that). A seat outside the app draws from
 * fixed defaults; wrap a tree in SeatViewSourceProvider to set the theme,
 * the detail tier or saved portraits.
 */

import "./kit.css";

export {
  AgentSeatView,
  SeatName,
  SEAT_PORTRAIT_PX,
  type SeatHealth,
  type SeatSignal,
} from "../components/nodes/AgentSeatView";
export { PreambleBubbleView } from "../components/nodes/PreambleBubbleView";
export { PulseHold, PulseStrips } from "../components/edges/WirePulseView";
export { ActivityMark, ActivityMarkFromSpec, setMarkMotionSource } from "../components/ActivityMark";
export { AgentPortrait } from "../components/AgentPortrait";
export { FeedCardView, FeedPortraitWell, type FeedCardViewProps } from "../components/feed/FeedCardView";
export {
  FIXED_SEAT_VIEW_SOURCE,
  SeatViewSourceProvider,
  fixedReadable,
  type Readable,
  type SeatViewSource,
} from "../components/seat-view-source";
export {
  DemoSeat,
  DemoWire,
  PULSE_BEAT_MS,
  TourStage,
  seatPort,
  useTourBeat,
  type DemoSeatProps,
} from "../components/onboarding/tour-demo";
export { terminalActivity, type ActivitySpec } from "../lib/activity";
export { mirrorMarkAtlas } from "../lib/activity-atlas";
export { mergedQuickReplies } from "../lib/quick-reply-rules";
export { AGENT_NODE_SIZE } from "../lib/node-geometry";
export type { PreambleItem, SeatBubble } from "../lib/preamble-feed";
export type { FeedItem } from "@shared/operator-feed";
export { feedItemRank } from "@shared/wire/operator-feed";
export { DEFAULT_QUICK_REPLIES } from "@shared/settings";
export { decodeQuiz, decodeScene, type Quiz, type Scene } from "@shared/learn";
export { WIRE_PULSE_MS } from "../lib/wire-pulse";
