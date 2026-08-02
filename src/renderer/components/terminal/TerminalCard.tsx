import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import {
  agentSeat$,
  presentationForSeat,
  subscribeAgentSeatState,
} from "../../lib/agent-seat-state";
import { terminalActivity } from "../../lib/activity";
import { ActivityCardWash } from "../ActivityMark";
import { terminal$ } from "../../lib/terminal-state";
import { onTerminalEvent } from "../../lib/terminal-events";
import { getVellumApi } from "../../lib/vellum-api";
import { ClaimedTaskStrip } from "../nodes/ClaimedTaskStrip";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";

const launchSummary = (
  launch:
    { readonly kind: string; readonly argv?: readonly string[] } | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length)
    return launch.argv.join(" ");
  return launch.kind;
};

/**
 * Terminal node body — identity + status only.
 * Open via double-click or the selection toolbar (TerminalToolbarActions).
 * No Start/Open/Kill buttons on the card (herdr pattern).
 * Managed-agent seat state paints attention (amber + !) / working (cyan).
 */
export function TerminalCard({
  node,
  graphBlocked = false,
}: {
  readonly node: CanvasNode;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
}) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const seatEvent = use$(
    agentSeat$.byBindingId[
      native?.bindingId ?? "__vellum-terminal-no-binding__"
    ],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[
      native?.bindingId ?? "__vellum-terminal-no-binding__"
    ],
  );

  const refresh = () =>
    native &&
    getVellumApi()
      ?.terminalGet?.(native.bindingId, native.hostId)
      .then((next) => {
        setSession(next);
        terminal$.sessionByBindingId[native.bindingId].set(next);
        if (next?.nodeId) {
          agentSeat$.bindingIdByNodeId[next.nodeId].set(native.bindingId);
        }
      })
      .catch(() => undefined);

  const running =
    session?.status === "running" || session?.status === "starting";

  useEffect(() => {
    subscribeAgentSeatState();
    void refresh();
    const off = onTerminalEvent((raw) => {
      if ((raw as { bindingId?: string }).bindingId === native?.bindingId)
        void refresh();
    });
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface.
    if (!running) {
      return off;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [native?.bindingId, native?.hostId, running]);

  if (!native)
    return <div className="text-[11px] text-dim">unbound terminal</div>;

  const label = native.label ?? (node.type === "text" ? node.text : "terminal");
  const seatState = seatEvent?.state;
  const presentation = presentationForSeat(seatState, needsLook === true);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const activity = terminalActivity({
    seatState,
    needsLook: needsLook === true,
    seatReason: seatEvent?.reason,
    running: session?.status === "running",
    starting: session?.status === "starting",
    graphBlocked,
    exitReason,
    exitMessage,
  });
  // Prefer spawn-failure / attention reason over the raw launch argv line.
  // turn-stalled keeps operator-facing "stalled" wording (not raw reason id).
  const attentionSubtitle =
    seatState === "attention"
      ? seatEvent?.reason === "turn-stalled" ||
        seatEvent?.reason === "prompt-stalled"
        ? "stalled — needs operator look"
        : seatEvent?.reason
      : undefined;
  const subtitle =
    (exitReason && exitMessage) ||
    attentionSubtitle ||
    (presentation === "done" ? "ready — review response" : undefined) ||
    launchSummary(native.launch);

  const complete = activity.mode === "pulse" && activity.tone === "green";
  return (
    <div
      className="group relative flex h-full w-full flex-col justify-between overflow-hidden"
      title="double-click to open"
      data-seat-state={presentation ?? seatState}
      data-exit-reason={exitReason}
      data-seat-complete={complete ? "true" : undefined}
    >
      {complete ? <ActivityCardWash tone="green" /> : null}
      <div className="relative z-[1]">
        <ExecutionCardHeader
          decal={
            <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
              <SquareTerminal size={15} />
            </div>
          }
          title={label}
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
      </div>
      <div className="relative z-[1]">
        <ClaimedTaskStrip node={node} />
      </div>
    </div>
  );
}
