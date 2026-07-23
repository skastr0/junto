import { useEffect, useState, type SyntheticEvent } from "react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumApi } from "../../lib/vellum-api";
import { openTerminalSurface, terminal$ } from "../../lib/terminal-state";
import { state$ } from "../../lib/state";
import { Button, StatusDot } from "../ui";

const launchSummary = (
  launch: { readonly kind: string; readonly argv?: readonly string[] } | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length) return launch.argv.join(" ");
  return launch.kind;
};

export function TerminalCard({ node }: { readonly node: CanvasNode }) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
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
    // an open surface. A stopped card has nothing to chase: Start/Kill and
    // terminal events drive its transitions, so no idle 2.5s churn per card.
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
  const stop = (event: SyntheticEvent) => {
    event.stopPropagation();
    setError(undefined);
    void getVellumApi()
      ?.terminalKill?.(native.bindingId, native.hostId)
      .then(() => refresh());
  };
  const start = (event: SyntheticEvent) => {
    event.stopPropagation();
    const api = getVellumApi();
    if (!api?.terminalCreate) {
      setError("terminal API unavailable — restart Vellum Command");
      return;
    }
    setBusy(true);
    setError(undefined);
    void api
      .terminalCreate({
        bindingId: native.bindingId,
        hostId: native.hostId,
        launch: native.launch,
        canvasName: state$.canvasName.peek(),
        nodeId: node.id,
        label: native.label,
      })
      .then((next) => {
        setSession(next);
        openTerminalSurface(node);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[terminal] create failed", err);
        setSession(undefined);
        setError(message || "start failed");
      })
      .finally(() => setBusy(false));
  };
  const label = native.label ?? (node.type === "text" ? node.text : "terminal");
  return (
    <div
      className="group flex h-full w-full flex-col justify-between overflow-hidden"
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (running) openTerminalSurface(node);
      }}
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
          {native.hostId} · {busy ? "starting…" : (session?.status ?? "stopped")}
          {session?.pid ? ` · pid ${session.pid}` : ""}
        </div>
        {error ? (
          <div role="alert" title={error} className="mt-1 line-clamp-2 break-words text-[10px] leading-snug text-crimson">
            {error}
          </div>
        ) : null}
      </div>
      <div className="mt-auto flex gap-1.5 pt-1.5">
        {running ? (
          <>
            <Button
              size="xs"
              variant="primary"
              className="nodrag nopan"
              onClick={(e) => {
                e.stopPropagation();
                openTerminalSurface(node);
              }}
            >
              Open
            </Button>
            <Button size="xs" variant="danger" className="nodrag nopan" onClick={stop}>
              Kill
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="primary"
            className="nodrag nopan"
            disabled={busy}
            onClick={start}
          >
            {busy ? "Starting…" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}
