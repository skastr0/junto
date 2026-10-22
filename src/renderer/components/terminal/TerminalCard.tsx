import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { TASKS_ENABLED } from "@shared/features";
import type { TerminalSessionSummary } from "@shared/terminal";
import { agentSeat$, subscribeAgentSeatState } from "../../lib/agent-seat-state";
import { subscribeSeatAwareness } from "../../lib/seat-awareness";
import { seatCardStatus } from "../../lib/seat-card-status";
import { terminal$ } from "../../lib/terminal-state";
import { onTerminalEvent } from "../../lib/terminal-events";
import { registerTerminalSessionPoll } from "../../lib/terminal-session-poll";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { getJuntoApi } from "../../lib/junto-api";
import { isOnMachine, machineLabelIn, useMachines, useThisMachineName } from "../../lib/machines";
import { renameTerminalNode } from "../../lib/mutations";
import { useNodeFieldOf } from "../../lib/use-model";
import { SeatTaskStrip } from "../nodes/SeatTaskStrip";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { KindCard, type SpineStatus } from "../nodes/SpineCard";
import { useNodeUrgency } from "../../lib/use-node-urgency";
import { RegionUrgency } from "@shared/wire/urgency";

/**
 * Terminal node body: identity and status only, a Spines leaf
 * (docs/node-card-language.md): the chip, a status tag, one line.
 * Open via double-click or the selection toolbar (TerminalToolbarActions).
 * No Start/Open/Kill buttons on the card.
 * Managed-agent seat state paints attention (amber + !) / working (cyan).
 *
 * The card body derives its status through `seatCardStatus`, the same function
 * the awareness hover reads, so the hover can never echo a status the card does
 * not show. The hover itself renders into the node shell's overlay slot: this
 * body is clipped, so a hover mounted here is painted away.
 */

export function TerminalCard({
  canvas,
  id,
  graphBlocked = false,
  renaming = false,
  onRenameDone,
}: {
  readonly canvas: string;
  readonly id: string;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  /** Rename only via RTS pencil (editNodeId) — not card double-click. */
  readonly onRenameDone?: () => void;
}) {
  // The terminal, read from the node store one field at a time: a move or a
  // resize of the card does not re-render it.
  const bindingId = useNodeFieldOf(canvas, id, "terminal", (terminal) => terminal.bindingId);
  const hostId = useNodeFieldOf(canvas, id, "terminal", (terminal) => terminal.host);
  const name = useNodeFieldOf(canvas, id, "terminal", (terminal) => terminal.label ?? "") ?? "";
  const launch = useNodeFieldOf(canvas, id, "terminal", (terminal) => terminal.launch);
  const native = bindingId !== undefined && hostId !== undefined ? { bindingId, hostId } : undefined;
  const thisMachine = useThisMachineName();
  const machines = useMachines();
  const [session, setSession] = useState<TerminalSessionSummary>();
  const seatEvent = use$(
    agentSeat$.byBindingId[
      native?.bindingId ?? "__junto-terminal-no-binding__"
    ],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[
      native?.bindingId ?? "__junto-terminal-no-binding__"
    ],
  );

  const applySession = (next: TerminalSessionSummary | undefined) => {
    if (!native) return;
    const prev = terminal$.sessionByBindingId[native.bindingId].peek();
    if (sessionChromeUnchanged(prev, next)) {
      setSession((current) => current ?? next);
      return;
    }
    setSession(next);
    terminal$.sessionByBindingId[native.bindingId].set(next);
    if (next?.nodeId) {
      agentSeat$.bindingIdByNodeId[next.nodeId].set(native.bindingId);
    }
  };

  const refresh = () =>
    native &&
    getJuntoApi()
      ?.terminalGet?.(native.bindingId, native.hostId)
      .then(applySession)
      .catch(() => undefined);

  const running =
    session?.status === "running" || session?.status === "starting";

  useEffect(() => {
    subscribeAgentSeatState();
    subscribeSeatAwareness();
    void refresh();
    // Routed by binding, so this card is no longer woken by every other
    // terminal's PTY output. shouldRefreshSessionFromTerminalEvent is a
    // separate cut: only session/exit change card chrome.
    const bindingId = native?.bindingId;
    const off = bindingId
      ? onTerminalEvent(
          (raw) => {
            if (!shouldRefreshSessionFromTerminalEvent(raw)) return;
            void refresh();
          },
          { bindingId },
        )
      : () => undefined;
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface. The poll is a backstop; `off` above is the primary
    // signal. Registration, not a per-card interval: one shared timer batch
    // reads every registered card's host with terminalList, so a 48-terminal
    // canvas costs one IPC round trip per tick instead of 48.
    if (!running || !bindingId) {
      return off;
    }
    const offPoll = registerTerminalSessionPoll(
      bindingId,
      native?.hostId,
      applySession,
    );
    return () => {
      off();
      offPoll();
    };
  }, [native?.bindingId, native?.hostId, running]);

  const status = seatCardStatus({
    face: bindingId === undefined ? undefined : { id, name, bindingId, launch },
    seatEvent,
    needsLook: needsLook === true,
    session,
    graphBlocked,
  });
  const spineStatus: SpineStatus | undefined = graphBlocked
    ? "blocked"
    : status?.seatState === "attention"
      ? "needs-you"
      : status?.seatState === "working" || running
        ? "working"
        : undefined;
  useNodeUrgency(
    id,
    spineStatus === "blocked"
      ? RegionUrgency.group.blocked
      : spineStatus === "needs-you"
        ? RegionUrgency.group["needs-you"]
        : undefined,
  );
  if (status === undefined)
    return <div className="text-body text-dim">unbound terminal</div>;

  if (native === undefined)
    return <div className="text-body text-dim">unbound terminal</div>;
  const { label, presentation, seatState, subtitle, complete } = status;
  // One line: what it runs or why it stopped, and where when it is not here.
  const line = isOnMachine(native.hostId, thisMachine)
    ? subtitle
    : `${subtitle} on ${machineLabelIn(machines, native.hostId)}`;
  const commitRename = (nextFirst: string) => {
    renameTerminalNode(id, nextFirst);
  };

  return (
    <div
      className="group relative flex h-full w-full flex-col"
      title="Open terminal"
      data-seat-state={presentation ?? seatState}
      data-exit-reason={session?.exitReason}
      data-process-live={status.processLive ? "true" : undefined}
      data-process-name={status.processName}
      data-seat-complete={complete ? "true" : undefined}
    >
      <KindCard
        kind="terminal"
        name={label}
        status={spineStatus}
        nameEditor={
          renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename terminal"
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : undefined
        }
        line={seatState === "attention" && seatEvent?.reason ? seatEvent.reason : line}
      />
      {TASKS_ENABLED ? <SeatTaskStrip nodeId={id} /> : null}
    </div>
  );
}
