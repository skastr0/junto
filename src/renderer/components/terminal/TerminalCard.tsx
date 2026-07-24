import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { terminal$ } from "../../lib/terminal-state";
import { getVellumApi } from "../../lib/vellum-api";
import { StatusDot } from "../ui";

const launchSummary = (
  launch: { readonly kind: string; readonly argv?: readonly string[] } | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length) return launch.argv.join(" ");
  return launch.kind;
};

/**
 * Terminal node body — identity + status only.
 * Open via double-click or the selection toolbar (TerminalToolbarActions).
 * No Start/Open/Kill buttons on the card (herdr pattern).
 */
export function TerminalCard({ node }: { readonly node: CanvasNode }) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();

  const refresh = () =>
    native &&
    getVellumApi()
      ?.terminalGet?.(native.bindingId, native.hostId)
      .then((next) => {
        setSession(next);
        terminal$.sessionByBindingId[native.bindingId].set(next);
      })
      .catch(() => undefined);

  const running = session?.status === "running" || session?.status === "starting";

  useEffect(() => {
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

  return (
    <div
      className="group flex h-full w-full flex-col justify-between overflow-hidden"
      title="double-click to open"
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
          <StatusDot tone={running ? "green" : "dim"} pulse={running} title={session?.status ?? "stopped"} />
        </div>
        <div className="mt-1 truncate text-[10px] tabular-nums text-dim">
          {native.hostId} · {session?.status ?? "stopped"}
        </div>
      </div>
    </div>
  );
}
