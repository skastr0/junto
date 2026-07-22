import { useEffect, useState, type SyntheticEvent } from "react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumApi } from "../../lib/vellum-api";
import { openTerminalSurface, terminal$ } from "../../lib/terminal-state";
import { state$ } from "../../lib/state";

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
  useEffect(() => {
    void refresh();
    const api = getVellumApi();
    const off = api?.onTerminalEvent?.((raw) => {
      if ((raw as { bindingId?: string }).bindingId === native?.bindingId) void refresh();
    });
    // Poll while running — lease-scoped events don't reach cards without an open surface.
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      off?.();
      window.clearInterval(timer);
    };
  }, [native?.bindingId, native?.hostId]);
  if (!native) return <div className="terminal-card">unbound terminal</div>;
  const running = session?.status === "running" || session?.status === "starting";
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
  return (
    <div
      className="terminal-card"
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (running) openTerminalSurface(node);
      }}
    >
      <div className="terminal-card__head">
        <span className={`terminal-card__lamp ${running ? "is-running" : ""}`} />{" "}
        <strong>{native.label ?? (node.type === "text" ? node.text : "terminal")}</strong>
      </div>
      <div className="terminal-card__meta">
        {native.hostId} · {busy ? "starting…" : (session?.status ?? "stopped")}
        {session?.pid ? ` · pid ${session.pid}` : ""}
      </div>
      {error ? (
        <div className="terminal-card__error" role="alert" title={error}>
          {error}
        </div>
      ) : null}
      <div className="terminal-card__actions">
        {running ? (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openTerminalSurface(node);
              }}
            >
              Open
            </button>
            <button type="button" onClick={stop}>
              Kill
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={start}>
            {busy ? "Starting…" : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}
