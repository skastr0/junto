/**
 * ActivityFeed producer — ACP chat plane + managed-terminal seat state +
 * process-bind presence.
 *
 * Binds `@shared/occupancy`'s ActivityFeed seam (S5 cut 1) from signals the
 * app already computes: `chatCoarse$` (ACP agent status; a live/connecting
 * session is the same process-bind-presence predicate `useRegionRollups`
 * already treats as `sessionLive` — see region-rollups.ts and the
 * `AgentActivity` contract in shared/region-rollup.ts), managed-agent seat
 * events (`agentSeat$`, bindingId-keyed).
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
import type { ActivityFeedService, OccupancyClue } from "@shared/occupancy";
import { resolveTerminalBinding } from "@shared/terminal";
import { chatActivity, type ActivityTone } from "./activity";
import { agentSeat$, clueFromAgentSeat } from "./agent-seat-state";
import { chatCoarse$, type AgentChatCoarse } from "./chat-state";
import {
  attentionAgentKey,
  attentionReasonsForNode,
  attentionReasonsForSeat,
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

type MinimalNode = Pick<CanvasNode, "id" | "ether">;

/**
 * Pure: an ActivityFeedService snapshot from the seats and the coarse chat
 * map. Each seat is its node id and agent key, as the model holds them; no
 * node shape is read. A real, non-null producer sourced only from the ACP
 * chat plane.
 */
export function chatActivityFeedOf(
  seats: Iterable<{ readonly id: string; readonly agentKey: string }>,
  chat: Record<string, AgentChatCoarse>,
): ActivityFeedService {
  const agentKeyByNodeId = new Map<string, string>();
  for (const seat of seats) agentKeyByNodeId.set(seat.id, seat.agentKey);
  return {
    clueFor: (nodeId) => {
      const agentKey = agentKeyByNodeId.get(nodeId);
      const coarse = agentKey !== undefined ? chat[agentKey] : undefined;
      return coarse ? clueFromChatCoarse(coarse) : undefined;
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
export function attentionCoarse$(seat: string | undefined | AttentionNode) {
  // A seat is named by its agent key. The node form is still taken while the
  // seat ring and the cards hand one; it goes when they pass the key.
  const agentKey = typeof seat === "object" ? attentionAgentKey(seat) : seat;
  return chatCoarse$[agentKey ?? NO_AGENT_KEY];
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
 * A seat's attention reasons from its agent key alone: the slice
 * `useNodeAttentionReasons` reads for an agent node, for a caller that holds
 * the seat and not a document node.
 */
export function useSeatAttentionReasons(agentKey: string | undefined): ReadonlyArray<string> {
  const coarse = use$(attentionCoarse$(agentKey)) as AgentChatCoarse | undefined;
  return useMemo(() => attentionReasonsForSeat(agentKey, coarse), [agentKey, coarse]);
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
  return useSeatOccupancyClue(agentKey, bindingId);
}

/**
 * The same clue for a caller that holds the seat and not a document node: its
 * agent key, when it is an agent, and the binding of its terminal session.
 */
export function useSeatOccupancyClue(
  agentKey: string | undefined,
  bindingId: string | undefined,
): OccupancyClue | undefined {
  const coarse = use$(chatCoarse$[agentKey ?? NO_AGENT_KEY]) as AgentChatCoarse | undefined;
  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? NO_BINDING]);
  return useMemo(() => {
    // Terminal seat telemetry is the authoritative harness for managed seats.
    return clueFromAgentSeat(seatEvent) ?? (coarse ? clueFromChatCoarse(coarse) : undefined);
  }, [coarse, seatEvent]);
}
