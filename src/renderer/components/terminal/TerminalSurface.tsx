import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CanvasNode } from "@shared/canvas";
import type { VellumTerminalApi } from "@shared/ipc";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumApi } from "../../lib/vellum-api";

type AttachResult = {
  readonly ok: boolean;
  readonly message?: string;
  readonly lease?: { readonly leaseId: string; readonly epoch: string };
  readonly cols?: number;
  readonly rows?: number;
  readonly journal?: readonly { readonly type: string; readonly data?: string; readonly seq?: bigint }[];
};

type LiveEvent = {
  readonly bindingId?: string;
  readonly epoch?: string;
  readonly type?: string;
  readonly data?: string;
  readonly seq?: bigint;
};

export function TerminalSurface({ node }: { readonly node: CanvasNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const leaseRef = useRef<string | undefined>(undefined);
  const epochRef = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState("attaching…");
  const binding = resolveTerminalBinding(node);
  const bindingId = binding?.kind === "native" ? binding.bindingId : "";

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      fontFamily: "SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#0b0d0c",
        foreground: "#e7e0d3",
        cursor: "#d6b66f",
        selectionBackground: "#6e604c88",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    requestAnimationFrame(() => fit.fit());
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden pane */
      }
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const api = getVellumApi() as VellumTerminalApi | undefined;
    const term = termRef.current;
    if (!api || !term || !bindingId) {
      setStatus("terminal unavailable");
      return;
    }
    let alive = true;
    const pending: LiveEvent[] = [];
    let attachDone = false;

    const offData = term.onData((data) => {
      const lease = leaseRef.current;
      if (lease) void api.terminalWrite(lease, data);
    });
    const offResize = term.onResize(({ cols, rows }) => {
      const lease = leaseRef.current;
      if (lease) void api.terminalResize(lease, cols, rows);
    });
    const offEvent = api.onTerminalEvent((raw) => {
      const event = raw as LiveEvent;
      if (event.bindingId !== bindingId) return;
      if (!attachDone) {
        pending.push(event);
        return;
      }
      if (event.epoch !== epochRef.current) return;
      if (event.type === "output" && event.data) term.write(event.data);
      if (event.type === "exit") setStatus("exited");
    });

    void api
      .terminalAttach({ bindingId, mode: "control", takeover: true })
      .then((raw) => {
        const result = raw as AttachResult;
        if (!alive) {
          // Late attach after unmount — release so control is not stranded.
          if (result.ok && result.lease) void api.terminalRelease(result.lease.leaseId);
          return;
        }
        if (!result.ok || !result.lease) {
          setStatus(result.message ?? "not running");
          attachDone = true;
          return;
        }
        leaseRef.current = result.lease.leaseId;
        epochRef.current = result.lease.epoch;
        let lastSeq: bigint | undefined;
        for (const item of result.journal ?? []) {
          if (item.type === "output" && item.data) term.write(item.data);
          if (item.seq !== undefined) lastSeq = item.seq;
        }
        attachDone = true;
        for (const event of pending) {
          if (event.epoch !== result.lease.epoch) continue;
          if (lastSeq !== undefined && event.seq !== undefined && event.seq <= lastSeq) continue;
          if (event.type === "output" && event.data) term.write(event.data);
          if (event.type === "exit") setStatus("exited");
        }
        pending.length = 0;
        setStatus("control");
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          term.focus();
        });
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : String(error)),
      );

    return () => {
      alive = false;
      offData.dispose();
      offResize.dispose();
      offEvent();
      const lease = leaseRef.current;
      leaseRef.current = undefined;
      if (lease) void api.terminalRelease(lease);
    };
  }, [bindingId]);

  return (
    <div className="native-terminal-surface" onMouseDown={() => termRef.current?.focus()}>
      <div className="native-terminal-surface__status">
        {node.type === "text" ? node.text : "terminal"}
        <span>{status}</span>
      </div>
      <div ref={hostRef} className="native-terminal-surface__xterm" />
    </div>
  );
}
