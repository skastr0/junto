/**
 * Permanent bottom-right dock for blocked / needs-operator-input state.
 *
 * Why permanent: the infinite canvas can park the subject far from the
 * viewport. Rising-edge SFX is easy to miss; node chips require the subject
 * on-screen. This dock stays until the state clears.
 */

import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { AlertTriangle, Ban } from "lucide-react";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  agentSeat$,
  terminalStatusByNodeIdFromSeats,
} from "../lib/agent-seat-state";
import {
  collectOperatorAttention,
  freestandingFromTerminalStatus,
  OPERATOR_ATTENTION_DOCK_MAX,
  OPERATOR_ATTENTION_HEADLINE,
  type OperatorAttentionItem,
} from "../lib/operator-attention";
import { nodeTitle } from "../lib/presentation";
import { useRegionRollups } from "../lib/region-rollups";
import { state$ } from "../lib/state";
import "./OperatorAttentionDock.css";

const focusItem = (item: OperatorAttentionItem): void => {
  if (!state$.doc.peek().nodes.some((n) => n.id === item.nodeId)) return;
  state$.selectedNodeId.set(item.nodeId);
  state$.selectedNodeIds.set([item.nodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(item.nodeId);
};

function AttentionCard({ item }: { readonly item: OperatorAttentionItem }) {
  const Icon = item.kind === "blocked" ? Ban : AlertTriangle;
  const reason = item.reasons[0];
  return (
    <button
      type="button"
      className={`op-attention-card op-attention-card--${item.kind}`}
      data-testid="operator-attention-card"
      data-kind={item.kind}
      data-node-id={item.nodeId}
      aria-label={`${OPERATOR_ATTENTION_HEADLINE[item.kind]}: ${item.label}. Focus node.`}
      onClick={() => focusItem(item)}
    >
      <span className="op-attention-card__icon" aria-hidden>
        <Icon size={16} strokeWidth={2.4} />
      </span>
      <span className="op-attention-card__body">
        <span className="op-attention-card__headline">
          {OPERATOR_ATTENTION_HEADLINE[item.kind]}
        </span>
        <span className="op-attention-card__label">{item.label}</span>
        {reason ? (
          <span className="op-attention-card__reason">{reason}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Fixed bottom-right permanent notifications for operator-critical seat state.
 * Renders nothing when the floor is clear.
 */
export function OperatorAttentionDock() {
  const rollups = useRegionRollups();
  const doc = use$(state$.doc);
  const seatByBinding = use$(agentSeat$.byBindingId) as Record<
    string,
    AgentSeatStateEvent | undefined
  >;
  const needsLookByBinding = use$(agentSeat$.needsLookByBindingId) as Record<
    string,
    boolean | undefined
  >;

  const items = useMemo(() => {
    const fromRollups = collectOperatorAttention(rollups);
    const covered = new Set(fromRollups.map((i) => i.nodeId));
    const terminalStatus = terminalStatusByNodeIdFromSeats(
      doc.nodes,
      seatByBinding ?? {},
      needsLookByBinding ?? {},
    );
    const freestanding = freestandingFromTerminalStatus(
      doc.nodes.map((n) => ({ id: n.id, label: nodeTitle(n) })),
      terminalStatus,
      covered,
    );
    return collectOperatorAttention(rollups, freestanding);
  }, [rollups, doc, seatByBinding, needsLookByBinding]);

  if (items.length === 0) return null;

  const visible = items.slice(0, OPERATOR_ATTENTION_DOCK_MAX);
  const overflow = items.length - visible.length;

  return (
    <div
      className="op-attention-dock"
      role="region"
      aria-label="Operator attention required"
      aria-live="assertive"
      data-testid="operator-attention-dock"
    >
      <div className="op-attention-dock__chrome">
        <span className="op-attention-dock__pulse" aria-hidden />
        <span className="op-attention-dock__title">
          {items.length} need{items.length === 1 ? "s" : ""} you
        </span>
      </div>
      <div className="op-attention-dock__list">
        {visible.map((item) => (
          <AttentionCard key={item.id} item={item} />
        ))}
      </div>
      {overflow > 0 ? (
        <div className="op-attention-dock__more">+{overflow} more · Space cycles</div>
      ) : (
        <div className="op-attention-dock__hint">click to focus · Space cycles</div>
      )}
    </div>
  );
}
