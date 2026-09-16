/**
 * ActivityFeed producer — ACP chat plane + managed-terminal seat state +
 * process-bind presence.
 *
 * Binds `@shared/occupancy`'s ActivityFeed seam (S5 cut 1) from signals the
 * app already computes: `chatCoarse$` (ACP agent status; a live/connecting
 * session is the same process-bind-presence predicate `useRegionRollups`
 * already treats as `sessionLive` — see region-rollups.ts and the
 * `AgentActivity` contract in shared/region-rollup.ts), managed-agent seat
 * events (`agentSeat$`, bindingId-keyed), and document `ether.flags`.
 * Classification reuses `chatActivity` from ./activity — the ActivityMark
 * source of truth — so occupancy and the chat activity mark never diverge
 * on what "attention" / "working" / "blocked" means for an agent seat.
 * Terminal seats use `clueFromAgentSeat` (same harness vocabulary).
 *
 * PTY producers stay a separate, hot-owned lane.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { ActivityFeedService, OccupancyClue, OccupancyFlagsValue } from "@shared/occupancy";
import { resolveTerminalBinding } from "@shared/terminal";
import { chatActivity, type ActivityTone } from "./activity";
import { agentSeat$, clueFromAgentSeat } from "./agent-seat-state";
import { chatCoarse$, type AgentChatCoarse } from "./chat-state";
import {
  attentionAgentKey,
  attentionReasonsForNode,
  type AttentionNode,
} from "./seat-projections";

const TONE_HARNESS: Record<ActivityTone, "idle" | "working" | "blocked" | "attention"> = {
  crimson: "blocked",
  amber: "attention",
  cyan: "working",
  green: "idle",
  steel: "idle",
};

/** Pure: one agent seat's clue from its coarse chat-plane status. */
export function clueFromChatCoarse(coarse: AgentChatCoarse): OccupancyClue {
  const hasOccupant = coarse.status === "live" || coarse.status === "connecting" || coarse.turnBusy;
  const spec = chatActivity({
    status: coarse.status,
    pendingPermission: coarse.pendingPermissionId !== undefined,
    sending: coarse.turnBusy,
    tools: coarse.hasBusyTools ? [{ status: "in_progress" }] : [],
  });
  return { hasOccupant, activity: { harness: TONE_HARNESS[spec.tone] } };
}

/** Pure: document `ether.flags` -> OccupancyFlags. Absent/empty -> undefined. */
export function flagsFromEther(
  flags: ReadonlyArray<string> | undefined,
): OccupancyFlagsValue | undefined {
  if (!flags || flags.length === 0) return undefined;
  return { parked: flags.includes("parked"), attention: flags.includes("attention") };
}

type MinimalNode = Pick<CanvasNode, "id" | "ether">;

/**
 * Pure: builds an ActivityFeedService snapshot from a document + the coarse
 * chat map. Satisfies the shared ActivityFeed contract end to end — a real,
 * non-null producer sourced only from the ACP chat plane and document flags.
 */
export function chatActivityFeed(
  doc: { readonly nodes: ReadonlyArray<MinimalNode> } | undefined,
  chat: Record<string, AgentChatCoarse>,
): ActivityFeedService {
  const agentKeyByNodeId = new Map<string, string>();
  const flagsByNodeId = new Map<string, OccupancyFlagsValue>();
  for (const node of doc?.nodes ?? []) {
    const entity = node.ether?.entity;
    if (entity?.kind === "agent" && entity.name !== undefined) {
      agentKeyByNodeId.set(node.id, entity.name);
    }
    const flags = flagsFromEther(node.ether?.flags);
    if (flags) flagsByNodeId.set(node.id, flags);
  }
  return {
    clueFor: (nodeId) => {
      const agentKey = agentKeyByNodeId.get(nodeId);
      const coarse = agentKey !== undefined ? chat[agentKey] : undefined;
      const base = coarse ? clueFromChatCoarse(coarse) : undefined;
      const flags = flagsByNodeId.get(nodeId);
      if (!base && !flags) return undefined;
      return { hasOccupant: base?.hasOccupant ?? false, activity: base?.activity, flags };
    },
  };
}

const NO_AGENT_KEY = "__junto-occupancy-no-agent__";
const NO_BINDING = "__junto-occupancy-no-binding__";

/**
 * The single observable slice a per-node consumer depends on for live
 * attention: this node's own agent key, or the no-agent sentinel. Exported
 * so a test can subscribe to exactly what the hook subscribes to.
 */
export function attentionCoarse$(node: AttentionNode) {
  return chatCoarse$[attentionAgentKey(node) ?? NO_AGENT_KEY];
}

/**
 * Node-scoped attention reasons: subscribes to this node's own agent-key
 * slice of `chatCoarse$`, never the whole map. Whole-map `use$(chatCoarse$)`
 * in a per-node component makes one agent's permission flip re-render every
 * node on the canvas, which mounts all of them (no viewport culling).
 * Batch consumers that project many nodes at once keep `liveAttentionReasons`.
 */
export function useNodeAttentionReasons(node: AttentionNode): ReadonlyArray<string> {
  const coarse = use$(attentionCoarse$(node)) as AgentChatCoarse | undefined;
  const ether = node.ether;
  return useMemo(
    () => attentionReasonsForNode({ ether }, coarse),
    [ether, coarse],
  );
}

/**
 * Node-scoped seam for card chrome: subscribes only to this node's own
 * agent-key slice of `chatCoarse$` and/or managed-terminal seat event,
 * never the whole document or the whole chat map. Cards are many; a
 * whole-document ActivityFeed rebuild per card per doc-wide state change
 * would refire on unrelated edits (drag, unrelated chat).
 * `chatActivityFeed` above still satisfies the shared contract for batch
 * consumers (tests, future RTS/digest use).
 *
 * Merge rule: native terminal seat state wins over ACP chat when both
 * exist (a terminal seat is the live process; chat is the legacy ACP path).
 */
export function useNodeOccupancyClue(node: MinimalNode): OccupancyClue | undefined {
  const agentKey =
    node.ether?.entity?.kind === "agent" ? node.ether.entity.name : undefined;
  const nativeBinding = resolveTerminalBinding(node as CanvasNode);
  const bindingId =
    nativeBinding?.kind === "native" ? nativeBinding.bindingId : undefined;
  const coarse = use$(chatCoarse$[agentKey ?? NO_AGENT_KEY]) as AgentChatCoarse | undefined;
  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? NO_BINDING]);
  const rawFlags = node.ether?.flags;
  return useMemo(() => {
    const seat = clueFromAgentSeat(seatEvent);
    const chat = coarse ? clueFromChatCoarse(coarse) : undefined;
    // Terminal seat telemetry is the authoritative harness for managed seats.
    const base = seat ?? chat;
    const flags = flagsFromEther(rawFlags);
    if (!base && !flags) return undefined;
    return {
      hasOccupant: base?.hasOccupant ?? false,
      activity: base?.activity,
      lastSeenAtMs: base?.lastSeenAtMs,
      flags,
    };
  }, [coarse, seatEvent, rawFlags]);
}
