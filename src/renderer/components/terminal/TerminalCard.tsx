import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { TASKS_ENABLED } from "@shared/features";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { agentSeat$, subscribeAgentSeatState } from "../../lib/agent-seat-state";
import { subscribeSeatAwareness } from "../../lib/seat-awareness";
import { seatCardStatus } from "../../lib/seat-card-status";
import { useNodeAttentionReasons } from "../../lib/occupancy-feed";
import { terminal$ } from "../../lib/terminal-state";
import { onTerminalEvent } from "../../lib/terminal-events";
import { registerTerminalSessionPoll } from "../../lib/terminal-session-poll";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { getJuntoApi } from "../../lib/junto-api";
import { renameTerminalNode } from "../../lib/mutations";
import { ClaimedTaskStrip } from "../nodes/ClaimedTaskStrip";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";

/**
 * Terminal node body — identity + status only.
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
  node,
  graphBlocked = false,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  /** Rename only via RTS pencil (editNodeId) — not card double-click. */
  readonly onRenameDone?: () => void;
}) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
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
  const attentionReasons = useNodeAttentionReasons(node);

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
    node,
    seatEvent,
    needsLook: needsLook === true,
    session,
    graphBlocked,
    attentionReasons,
  });
  if (status === undefined)
    return <div className="text-[11px] text-dim">unbound terminal</div>;

  if (native === undefined)
    return <div className="text-[11px] text-dim">unbound terminal</div>;
  const { label, presentation, seatState, subtitle, activity, complete } = status;
  const commitRename = (nextFirst: string) => {
    renameTerminalNode(node.id, nextFirst);
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
      <div className="flex h-full w-full flex-col justify-between overflow-hidden">
        <ExecutionCardHeader
          decal={
            <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
              <SquareTerminal size={15} />
            </div>
          }
          title={
            renaming && onRenameDone ? (
              <FirstLineRenameInput
                initial={label}
                ariaLabel="Rename terminal"
                onCommit={commitRename}
                onDone={onRenameDone}
              />
            ) : (
              <div
                className="truncate font-mono text-[14px] font-semibold leading-snug text-ink"
                title={label}
              >
                {label}
              </div>
            )
          }
          subtitle={subtitle}
          activity={
            seatState === "attention" && seatEvent?.reason
              ? { ...activity, label: seatEvent.reason }
              : activity
          }
        />
        <div className="mt-1 truncate text-[10px] tabular-nums text-dim">
          {native.hostId}
        </div>
        {TASKS_ENABLED ? <ClaimedTaskStrip node={node} /> : null}
      </div>
    </div>
  );
}
