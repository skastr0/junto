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
  readonly journal?: readonly {
    readonly type: string;
    readonly data?: string;
    readonly seq?: bigint;
  }[];
};

type LiveEvent = {
  readonly bindingId?: string;
  readonly epoch?: string;
  readonly type?: string;
  readonly data?: string;
  readonly seq?: bigint;
};

/** Debounce layout thrash from pin/focus/dock animations (same idea as herdr). */
const RESIZE_DEBOUNCE_MS = 60;

export function TerminalSurface({ node }: { readonly node: CanvasNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const leaseRef = useRef<string | undefined>(undefined);
  const epochRef = useRef<string | undefined>(undefined);
  const apiRef = useRef<VellumTerminalApi | undefined>(undefined);
  const lastGeom = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const [status, setStatus] = useState("attaching…");
  const binding = resolveTerminalBinding(node);
  const bindingId = binding?.kind === "native" ? binding.bindingId : "";

  /** Fit xterm to the host and push cols/rows to the PTY when geometry changes. */
  const pushResize = (): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    // Hidden / zero-size during zone transitions — skip (avoid 0x0 PTY).
    if (host.clientWidth < 20 || host.clientHeight < 20) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const cols = term.cols | 0;
    const rows = term.rows | 0;
    if (cols < 20 || rows < 5) return;
    if (lastGeom.current.cols === cols && lastGeom.current.rows === rows) return;
    lastGeom.current = { cols, rows };
    const lease = leaseRef.current;
    const api = apiRef.current;
    if (lease && api) void api.terminalResize(lease, cols, rows);
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
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

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushResize();
      }, RESIZE_DEBOUNCE_MS);
    };

    requestAnimationFrame(() => pushResize());
    window.addEventListener("resize", scheduleResize);
    // Observe the outer surface (flex parent) — pin/dock changes its box first.
    const observer = new ResizeObserver(() => scheduleResize());
    observer.observe(host);
    if (root) observer.observe(root);

    return () => {
      window.removeEventListener("resize", scheduleResize);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const api = getVellumApi() as VellumTerminalApi | undefined;
    const term = termRef.current;
    apiRef.current = api;
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
    // Prefer pushResize as the single PTY resize path (debounced). Keep onResize
    // as a backup when xterm itself changes geometry without our observer.
    const offResize = term.onResize(({ cols, rows }) => {
      const lease = leaseRef.current;
      if (!lease) return;
      if (lastGeom.current.cols === cols && lastGeom.current.rows === rows) return;
      lastGeom.current = { cols, rows };
      void api.terminalResize(lease, cols, rows);
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
        // Layout often settles after first paint / pin animation — fit twice.
        requestAnimationFrame(() => {
          pushResize();
          term.focus();
          setTimeout(() => pushResize(), 120);
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
    <div
      ref={rootRef}
      className="native-terminal-surface"
      onMouseDown={() => termRef.current?.focus()}
    >
      <div className="native-terminal-surface__status">
        {node.type === "text" ? node.text : "terminal"}
        <span>{status}</span>
      </div>
      <div ref={hostRef} className="native-terminal-surface__xterm" />
    </div>
  );
}
