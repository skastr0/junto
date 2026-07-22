import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CanvasNode } from "@shared/canvas";
import type { VellumTerminalApi } from "@shared/ipc";
import { resolveTerminalBinding } from "@shared/terminal";
import { MONO_CELL } from "../../lib/focus-measure";
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

const FONT_SIZE = MONO_CELL.fontSizePx;
/** Same cell estimate herdr uses when FitAddon under-reports. */
const CELL_W = MONO_CELL.fontSizePx * MONO_CELL.ratio;
const CELL_H = MONO_CELL.fontSizePx * 1.2;
/** Debounce layout thrash from pin/focus/dock animations. */
const RESIZE_DEBOUNCE_MS = 80;
/** After open/attach, wait for focus shell CSS animation (~160ms) then fit hard. */
const SETTLE_FIT_MS = 200;

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
  const [geomLabel, setGeomLabel] = useState("");
  const binding = resolveTerminalBinding(node);
  const bindingId = binding?.kind === "native" ? binding.bindingId : "";
  const hostId = binding?.kind === "native" ? binding.hostId : "local";

  /**
   * Measure host → set xterm cols/rows → PTY resize.
   * Single authority for geometry (no parallel onResize→PTY path).
   */
  const pushResize = (): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;

    const w = host.clientWidth;
    const h = host.clientHeight;
    // Hidden / zero-size during zone transitions — skip (avoid 0×0 PTY).
    if (w < 40 || h < 40) return;

    try {
      fit.fit();
    } catch {
      // fall through to pixel fallback
    }

    let cols = term.cols | 0;
    let rows = term.rows | 0;

    // FitAddon sometimes under-measures before layout settles. Floor from pixels.
    const minCols = Math.max(20, Math.floor(w / CELL_W));
    const minRows = Math.max(5, Math.floor(h / CELL_H));
    if (cols < minCols * 0.85 || rows < minRows * 0.85) {
      cols = Math.min(300, minCols);
      rows = Math.min(120, minRows);
      try {
        term.resize(cols, rows);
      } catch {
        return;
      }
    }

    cols = Math.max(20, Math.min(300, cols));
    rows = Math.max(5, Math.min(120, rows));
    if (lastGeom.current.cols === cols && lastGeom.current.rows === rows) {
      setGeomLabel(`${cols}×${rows}`);
      return;
    }
    lastGeom.current = { cols, rows };
    setGeomLabel(`${cols}×${rows}`);

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
      fontFamily: "SFMono-Regular, Menlo, ui-monospace, monospace",
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
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

    // Initial + post-animation settle (focus-surface-enter is 160ms).
    requestAnimationFrame(() => {
      pushResize();
      setTimeout(() => pushResize(), SETTLE_FIT_MS);
    });

    window.addEventListener("resize", scheduleResize);
    const observer = new ResizeObserver(() => scheduleResize());
    observer.observe(host);
    if (root) observer.observe(root);
    // Focus panel itself often resizes after mount (stored focusSize).
    const panel = root?.closest(".focus-surface__panel") ?? null;
    if (panel) observer.observe(panel);

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

    // Do NOT wire term.onResize → PTY. pushResize is the only path (avoids
    // double-fire and thrash with FitAddon).

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
      .terminalAttach({ bindingId, mode: "control", takeover: true, hostId })
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
        // Layout settles after attach + focus animation.
        requestAnimationFrame(() => {
          pushResize();
          term.focus();
          setTimeout(() => pushResize(), SETTLE_FIT_MS);
          setTimeout(() => pushResize(), SETTLE_FIT_MS + 150);
        });
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : String(error)),
      );

    return () => {
      alive = false;
      offData.dispose();
      offEvent();
      const lease = leaseRef.current;
      leaseRef.current = undefined;
      if (lease) void api.terminalRelease(lease);
    };
  }, [bindingId, hostId]);

  return (
    <div
      ref={rootRef}
      className="native-terminal-surface"
      onMouseDown={() => termRef.current?.focus()}
    >
      <div className="native-terminal-surface__status">
        <span className="native-terminal-surface__title">
          {node.type === "text" ? node.text : "terminal"}
        </span>
        <span>
          {status}
          {geomLabel ? ` · ${geomLabel}` : ""}
        </span>
      </div>
      <div ref={hostRef} className="native-terminal-surface__xterm" />
    </div>
  );
}
