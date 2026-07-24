import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CanvasNode } from "@shared/canvas";
import type { VellumTerminalApi } from "@shared/ipc";
import { resolveTerminalBinding } from "@shared/terminal";
import { MONO_CELL } from "../../lib/focus-measure";
import { use$ } from "@legendapp/state/react";
import {
  closeWorkbenchSurface,
  dock$,
  pinWorkbenchSurface,
  terminalSurfaceId,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { surfaceById } from "../../lib/surface-registry";
import { getVellumApi } from "../../lib/vellum-api";
import {
  VELLUM_XTERM_FONT_FAMILY,
  VELLUM_XTERM_THEME,
} from "../../lib/terminal-theme";
import { ActivityMark } from "../ActivityMark";
import { Button, OverlayHeader } from "../ui";

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
/** Fallback cell when xterm has not measured fonts yet (13×0.6 / 13×1.2). */
const FALLBACK_CELL_W = MONO_CELL.fontSizePx * MONO_CELL.ratio;
const FALLBACK_CELL_H = MONO_CELL.fontSizePx * 1.2;
/** Must match CSS padding on `.native-terminal-surface__xterm .xterm`. */
const XTERM_PAD_X = 16; // 8 + 8
const XTERM_PAD_Y = 12; // 6 + 6
/** Debounce layout thrash from pin/focus/dock animations. */
const RESIZE_DEBOUNCE_MS = 48;
/** After open/attach, wait for focus-shell enter + stored size apply. */
const SETTLE_FITS_MS = [0, 50, 160, 320, 600] as const;

type XtermCore = {
  readonly _renderService?: {
    readonly dimensions?: {
      readonly css?: {
        readonly cell?: { readonly width?: number; readonly height?: number };
      };
    };
  };
};

const readCellSize = (term: Terminal): { cellW: number; cellH: number } => {
  const core = term as unknown as { _core?: XtermCore };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  const cellW = cell?.width && cell.width > 1 ? cell.width : FALLBACK_CELL_W;
  const cellH = cell?.height && cell.height > 1 ? cell.height : FALLBACK_CELL_H;
  return { cellW, cellH };
};

/**
 * Geometry authority: host box → cols×rows.
 * Never trust FitAddon alone — when the flex chain is content-sized to the
 * default 80×24 canvas, FitAddon and a clientWidth floor both freeze on that
 * island. getBoundingClientRect on a flex:1;height:0 host is the real pane.
 */
const measureHost = (
  host: HTMLElement,
  term: Terminal,
): { cols: number; rows: number; w: number; h: number } | null => {
  const rect = host.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w < 40 || h < 40) return null;

  const { cellW, cellH } = readCellSize(term);
  const innerW = Math.max(0, w - XTERM_PAD_X);
  const innerH = Math.max(0, h - XTERM_PAD_Y);
  const cols = Math.max(20, Math.min(300, Math.floor(innerW / cellW)));
  const rows = Math.max(5, Math.min(120, Math.floor(innerH / cellH)));
  return { cols, rows, w, h };
};

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

  const pushResize = (): void => {
    const term = termRef.current;
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!term || !host) return;

    const measured = measureHost(host, term);
    if (!measured) return;

    let { cols, rows } = measured;

    // FitAddon as a secondary vote once the host already has a real box.
    // Prefer the larger of host-pixels vs fit so we never shrink to an island.
    if (fit) {
      try {
        const proposed = fit.proposeDimensions();
        if (proposed && !Number.isNaN(proposed.cols) && !Number.isNaN(proposed.rows)) {
          cols = Math.max(cols, Math.min(300, proposed.cols | 0));
          rows = Math.max(rows, Math.min(120, proposed.rows | 0));
        }
      } catch {
        // ignore — host measure is enough
      }
    }

    cols = Math.max(20, Math.min(300, cols));
    rows = Math.max(5, Math.min(120, rows));

    if (term.cols !== cols || term.rows !== rows) {
      try {
        term.resize(cols, rows);
      } catch {
        return;
      }
    }

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
      fontFamily: VELLUM_XTERM_FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      theme: VELLUM_XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    host.replaceChildren();
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    const scheduleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushResize();
      }, RESIZE_DEBOUNCE_MS);
    };
    const hardFitBurst = (): void => {
      for (const ms of SETTLE_FITS_MS) {
        settleTimers.push(setTimeout(() => pushResize(), ms));
      }
    };

    requestAnimationFrame(() => {
      pushResize();
      hardFitBurst();
    });

    window.addEventListener("resize", scheduleResize);
    const observer = new ResizeObserver(() => scheduleResize());
    observer.observe(host);
    if (root) observer.observe(root);
    // Focus panel + workbench panes reflow on pin/split/stored focusSize.
    const ancestors = [
      root?.closest(".focus-surface__panel"),
      root?.closest(".workbench-pane"),
      root?.closest(".workbench-panes"),
      root?.closest(".work-focus-shell"),
      root?.closest(".dock-slot"),
    ];
    for (const el of ancestors) {
      if (el instanceof Element) observer.observe(el);
    }

    return () => {
      window.removeEventListener("resize", scheduleResize);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const t of settleTimers) clearTimeout(t);
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

    // Do NOT wire term.onResize → PTY. pushResize is the only path.

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
        requestAnimationFrame(() => {
          pushResize();
          term.focus();
          for (const ms of SETTLE_FITS_MS) {
            setTimeout(() => pushResize(), ms);
          }
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

  const label = node.type === "text" ? node.text : "terminal";
  const surfaceId = terminalSurfaceId(node.id);
  const registry = use$(dock$.registry);
  const surface = surfaceById(registry, surfaceId);
  const pinned = surface?.zone === "pinned";
  const closeSurface = () => closeWorkbenchSurface(surfaceId);
  const togglePin = () => {
    if (pinned) unpinWorkbenchSurface(surfaceId);
    else pinWorkbenchSurface(surfaceId);
  };
  const killSession = () => {
    void getVellumApi()
      ?.terminalKill?.(bindingId, hostId)
      .then(() => setStatus("exited"));
  };
  const attached = status === "control";

  return (
    <div
      ref={rootRef}
      className="native-terminal-surface"
      onMouseDown={() => termRef.current?.focus()}
    >
      <OverlayHeader
        eyebrow={`terminal · ${hostId} · close detaches (session keeps running)`}
        title={label}
        status={
          <span className="native-terminal-surface__status inline-flex items-center gap-1.5">
            <ActivityMark
              mode={attached ? "static" : "wave"}
              tone={status === "exited" ? "crimson" : "amber"}
              size="inline"
              label={status}
            />
            {status}
            {geomLabel ? ` · ${geomLabel}` : ""}
          </span>
        }
        actions={
          <>
            <Button
              size="xs"
              variant="chrome"
              title={pinned ? "Move to focus shell" : "Pin to side dock"}
              onClick={togglePin}
            >
              {pinned ? "Unpin" : "Pin"}
            </Button>
            {attached ? (
              <Button size="xs" variant="danger" onClick={killSession}>
                Kill
              </Button>
            ) : null}
            <Button size="xs" variant="primary" onClick={closeSurface}>
              Close
            </Button>
          </>
        }
      />
      <div ref={hostRef} className="native-terminal-surface__xterm" />
    </div>
  );
}
