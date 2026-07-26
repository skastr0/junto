import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import {
  harnessFromSeatState,
  agentSeat$,
  subscribeAgentSeatState,
} from "../../lib/agent-seat-state";
import { terminal$ } from "../../lib/terminal-state";
import { getVellumApi } from "../../lib/vellum-api";
import { Chip, StatusDot, type StatusTone } from "../ui";

const launchSummary = (
  launch: { readonly kind: string; readonly argv?: readonly string[] } | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length) return launch.argv.join(" ");
  return launch.kind;
};

const seatDot = (
  seatState: string | undefined,
  running: boolean,
): { readonly tone: StatusTone; readonly pulse: boolean; readonly title: string } => {
  if (seatState === "attention") {
    return { tone: "amber", pulse: true, title: "needs operator input" };
  }
  if (seatState === "working") {
    return { tone: "cyan", pulse: true, title: "working" };
  }
  if (running) {
    return { tone: "green", pulse: true, title: "running" };
  }
  return { tone: "dim", pulse: false, title: "stopped" };
};

/**
 * Terminal node body — identity + status only.
 * Open via double-click or the selection toolbar (TerminalToolbarActions).
 * No Start/Open/Kill buttons on the card (herdr pattern).
 * Managed-agent seat state paints attention (amber + !) / working (cyan).
 */
export function TerminalCard({ node }: { readonly node: CanvasNode }) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const seatEvent = use$(
    agentSeat$.byBindingId[native?.bindingId ?? "__vellum-terminal-no-binding__"],
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

  const running = session?.status === "running" || session?.status === "starting";

  useEffect(() => {
    subscribeAgentSeatState();
    void refresh();
    const api = getVellumApi();
    const off = api?.onTerminalEvent?.((raw) => {
      if ((raw as { bindingId?: string }).bindingId === native?.bindingId) void refresh();
    });
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface.
    if (!running) {
      return () => off?.();
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      off?.();
      window.clearInterval(timer);
    };
  }, [native?.bindingId, native?.hostId, running]);

  if (!native) return <div className="text-[11px] text-dim">unbound terminal</div>;

  const label = native.label ?? (node.type === "text" ? node.text : "terminal");
  const seatState = seatEvent?.state;
  const dot = seatDot(seatState, running);
  const harness = seatState ? harnessFromSeatState(seatState) : undefined;
  const statusLine =
    seatState === "attention"
      ? "needs input"
      : seatState === "working"
        ? "working"
        : (session?.status ?? "stopped");

  return (
    <div
      className="group flex h-full w-full flex-col justify-between overflow-hidden"
      title="double-click to open"
      data-seat-state={seatState}
    >
      <div>
        <div className="flex items-center gap-2">
          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
            <SquareTerminal size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[14px] font-semibold leading-snug text-ink">
              {label}
            </div>
            <div className="truncate text-[11px] text-dim">{launchSummary(native.launch)}</div>
          </div>
          {seatState === "attention" ? (
            <Chip tone="amber" title={seatEvent?.reason ?? "needs operator input"}>
              !
            </Chip>
          ) : null}
          <StatusDot tone={dot.tone} pulse={dot.pulse} title={dot.title} />
        </div>
        <div className="mt-1 truncate text-[10px] tabular-nums text-dim">
          {native.hostId} · {statusLine}
          {harness && harness !== "idle" && harness !== "unknown" ? ` · ${harness}` : ""}
        </div>
      </div>
    </div>
  );
}
