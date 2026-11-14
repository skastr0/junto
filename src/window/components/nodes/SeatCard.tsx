import { use$ } from "@legendapp/state/react";

import { TASKS_ENABLED } from "@shared/features";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { useSeatSignalRollup } from "../../lib/agent-signals-state";
import { machineLabel, onThisMachine, useSeatMachineLine } from "../../lib/machines";
import { editText } from "../../lib/mutations";
import { cardMark, seatFactsForNode } from "../../lib/seat-projections";
import { seatLaunchMovedKey, seatStillForNextTurn, useSeatCacheWindow, useSeatFreshNext } from "../../lib/seat-next-launch";
import { SEAT_FRESH_NEXT_LINE } from "@shared/seat-next-launch";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { accentColor, INK } from "../../lib/theme";
import { useNodeFieldOf } from "../../lib/use-model";
import { AgentSeat, SeatName } from "./AgentSeat";
import { SeatTaskStrip } from "./SeatTaskStrip";
import { FirstLineRenameInput } from "./FirstLineRenameInput";

const NO_BINDING = "__junto-seat-card-no-binding__";

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
  const name = useNodeFieldOf(canvas, id, "agent", (seat) => seat.label);
  const color = useNodeFieldOf(canvas, id, "agent", (seat) => seat.color);
  const harness = useNodeFieldOf(canvas, id, "agent", (seat) => seat.harness);
  const bindingId = useNodeFieldOf(canvas, id, "agent", (seat) => seat.bindingId);
  const hostId = useNodeFieldOf(canvas, id, "agent", (seat) => seat.host);
  const overseer = useNodeFieldOf(canvas, id, "agent", (seat) => seat.overseer) === true;

  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? NO_BINDING]);
  const needsLook = use$(agentSeat$.needsLookByBindingId[bindingId ?? NO_BINDING]);
  const session = use$(terminal$.sessionByBindingId[bindingId ?? NO_BINDING]);
  // Session hydration is the canvas feed's (canvas/feed/sessions.ts): the
  // store above already holds what terminalGet and the terminal events say.
  const machineLine = useSeatMachineLine(hostId, harness);
  // A seat on another machine is answered once the link to it is up.
  const reachable = use$(() => (hostId === undefined ? undefined : state$.machineFacts[hostId].reachable.get()));
  // Shown here, the operator holds the seat's session; closing it lets go.
  const viewed = use$(() => terminal$.openByNodeId[id].get() !== undefined);
  // A raised hand waits on the operator, whatever the screen says.
  const hand = useSeatSignalRollup(canvas, id)?.kind;
  const facts = seatFactsForNode({
    nodeId: id,
    seatEvent,
    session,
    needsLook: needsLook === true,
    graphBlocked,
    managedSeat: true,
  });
  const mark = cardMark(facts);
  // A still seat whose next turn starts fresh says so; one that continues
  // says nothing more than its ring. Still: no process, or idle. A seat that
  // is blocked or needs the operator says only that.
  const freshNext = useSeatFreshNext(
    canvas,
    id,
    seatStillForNextTurn({ facts, mark, hand, seatState: seatEvent?.state }),
    seatLaunchMovedKey({
      bindingId,
      seatState: seatEvent?.state,
      seatAt: seatEvent?.at,
      epoch: session?.epoch,
      status: session?.status,
      reachable,
      viewed,
    }),
  );
  const activity = freshNext ? { ...mark, label: SEAT_FRESH_NEXT_LINE } : mark;
  // The same answer: a still seat that picks up where it was, against its
  // cache window. Never said with "fresh next"; main tells one or the other.
  const cacheWindow = useSeatCacheWindow(canvas, id);
  const cacheMachine = use$(() => (hostId === undefined || onThisMachine(hostId) ? "this machine" : machineLabel(hostId)));
  const cache = cacheWindow && !freshNext ? { window: cacheWindow, harness, machine: cacheMachine } : undefined;

  if (name === undefined) return null;

  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  // Which machine a seat sits on is not what the operator reads an agent node
  // for, and it crowded out the claimed task. The machine is named only when
  // it is why the seat cannot run; that outranks the spawn failure it causes.
  // Spawn failures surface as a context line so the mark + copy both land.
  const context = machineLine?.line ?? (exitReason && exitMessage ? exitMessage : undefined);
  // Rename still edits the document; it becomes a command when main serves them.
  const commitRename = (next: string) => editText(id, next);

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
      data-machine-state={machineLine?.state}
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
        cache={cache}
        host={hostId}
      >
        {TASKS_ENABLED ? <SeatTaskStrip nodeId={id} /> : null}
      </AgentSeat>
    </div>
  );
}
