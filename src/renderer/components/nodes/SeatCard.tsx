import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";

import { TASKS_ENABLED } from "@shared/features";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { getJuntoApi } from "../../lib/junto-api";
import { editText } from "../../lib/mutations";
import { useSeatAttentionReasons } from "../../lib/occupancy-feed";
import { cardMark, seatFactsForNode } from "../../lib/seat-projections";
import { onTerminalEvent } from "../../lib/terminal-events";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { terminal$ } from "../../lib/terminal-state";
import { accentColor, INK } from "../../lib/theme";
import { modelStore, useNodeFieldOf } from "../../lib/use-model";
import { AgentSeat, SeatName } from "./AgentSeat";
import { ClaimedTaskStrip } from "./ClaimedTaskStrip";
import { FirstLineRenameInput } from "./FirstLineRenameInput";

const NO_BINDING = "__junto-seat-card-no-binding__";

const firstLine = (label: string): string => label.split("\n")[0] ?? "";

/**
 * A seat on the canvas, read from the node store by canvas and id. Each field
 * is its own read, so a move or a resize of the seat does not re-render its
 * card. Renders nothing while the store holds no seat under this id.
 */
export function SeatCard({
  canvas,
  id,
  graphBlocked = false,
  renaming = false,
  onRenameDone,
}: {
  readonly canvas: string;
  readonly id: string;
  /** Execution-graph blocked: crimson spinner even when the seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
}) {
  const name = useNodeFieldOf(canvas, id, "agent", (seat) => firstLine(seat.label));
  const color = useNodeFieldOf(canvas, id, "agent", (seat) => seat.color);
  const harness = useNodeFieldOf(canvas, id, "agent", (seat) => seat.harness);
  const bindingId = useNodeFieldOf(canvas, id, "agent", (seat) => seat.bindingId);
  const hostId = useNodeFieldOf(canvas, id, "agent", (seat) => seat.host);
  const overseer = useNodeFieldOf(canvas, id, "agent", (seat) => seat.overseer) === true;
  const agentKey = useNodeFieldOf(canvas, id, "agent", (seat) => seat.name);

  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? NO_BINDING]);
  const needsLook = use$(agentSeat$.needsLookByBindingId[bindingId ?? NO_BINDING]);
  const session = use$(terminal$.sessionByBindingId[bindingId ?? NO_BINDING]);
  // Hydrate session cache so pre-ownership failures (cli-missing) paint on the card.
  useEffect(() => {
    if (!bindingId) return;
    const refresh = () =>
      getJuntoApi()
        ?.terminalGet?.(bindingId, hostId)
        .then((next) => {
          const prev = terminal$.sessionByBindingId[bindingId].peek();
          if (sessionChromeUnchanged(prev, next)) return;
          terminal$.sessionByBindingId[bindingId].set(next);
        })
        .catch(() => undefined);
    void refresh();
    // Routed by binding: the card hears its own terminal and no other. The
    // session/exit cut below is a separate predicate and stays.
    const off = onTerminalEvent(
      (raw) => {
        if (!shouldRefreshSessionFromTerminalEvent(raw)) return;
        void refresh();
      },
      { bindingId },
    );
    return off;
  }, [bindingId, hostId]);
  const attentionReasons = useSeatAttentionReasons(agentKey);

  if (name === undefined) return null;

  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const activity = cardMark(
    seatFactsForNode({
      nodeId: id,
      seatEvent,
      session,
      needsLook: needsLook === true,
      graphBlocked,
      attentionReasons,
      managedSeat: true,
    }),
  );
  // Host is deliberately absent: which machine a seat sits on is not what the
  // operator reads an agent node for, and it crowded out the claimed task.
  // Spawn failures surface as a context line so the mark + copy both land.
  const context = exitReason && exitMessage ? exitMessage : undefined;
  // Rename still edits the document; it becomes a command when main serves them.
  const commitRename = (next: string) => {
    const seat = modelStore.node$(canvas, id).peek();
    if (seat?.kind !== "agent") return;
    const rest = seat.label.split("\n").slice(1).join("\n");
    editText(id, rest ? `${next}\n${rest}` : next);
  };

  const complete = activity.mode === "pulse" && activity.tone === "green";
  const title =
    renaming && onRenameDone ? (
      <FirstLineRenameInput
        initial={name}
        ariaLabel="Rename agent node"
        onCommit={commitRename}
        onDone={onRenameDone}
      />
    ) : (
      <SeatName name={name} color={color ? accentColor(color) : INK} />
    );
  const seatActivity =
    seatEvent?.state === "attention" && seatEvent.reason
      ? { ...activity, label: seatEvent.reason }
      : activity;
  // An agent is a seat, not a card: its ring is the status instrument.
  return (
    <div
      className="factory-agent-card relative flex h-full w-full flex-col justify-center overflow-hidden"
      data-exit-reason={exitReason}
      data-seat-complete={complete ? "true" : undefined}
      data-overseer={overseer ? "true" : undefined}
    >
      <AgentSeat
        canvas={canvas}
        id={id}
        bindingId={bindingId}
        activity={seatActivity}
        title={title}
        harness={harness}
        context={context}
        overseer={overseer}
      >
        {TASKS_ENABLED ? <ClaimedTaskStrip nodeId={id} /> : null}
      </AgentSeat>
    </div>
  );
}
