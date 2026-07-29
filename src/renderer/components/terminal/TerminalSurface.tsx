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

const KILL_ARM_MS = 3000;

type AttachResult = {
  readonly ok: boolean;
  readonly message?: string;
  readonly lease?: { readonly leaseId: string; readonly epoch: string };
  readonly cols?: number;
  readonly rows?: number;
  /** Preferred: full headless grid for long-session attach (no journal ring). */
  readonly screen?: {
    readonly bindingId?: string;
    readonly epoch?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly seq?: bigint;
    readonly lines?: readonly string[];
  };
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
/**
 * After the settle burst, force a one-cell PTY nudge so TUI apps (Grok, etc.)
 * redraw when pin remount lands on a stable geom that would otherwise skip
 * terminalResize (lastGeom already matches).
 */
const PTY_NUDGE_AFTER_SETTLE_MS = 650;

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
  // Prefer the live .xterm box (already inset by CSS). Fall back to host − pad
  // before the first open.
  const surface = (term.element ?? host) as HTMLElement;
  const rect = surface.getBoundingClientRect();
  let w = rect.width;
  let h = rect.height;
  if ((!term.element || w < 40 || h < 40) && surface !== host) {
    const hostRect = host.getBoundingClientRect();
    w = Math.max(0, hostRect.width - XTERM_PAD_X);
    h = Math.max(0, hostRect.height - XTERM_PAD_Y);
  } else if (!term.element) {
    w = Math.max(0, w - XTERM_PAD_X);
    h = Math.max(0, h - XTERM_PAD_Y);
  }
  if (w < 40 || h < 40) return null;

  const { cellW, cellH } = readCellSize(term);
  const cols = Math.max(20, Math.min(300, Math.floor(w / cellW)));
  const rows = Math.max(5, Math.min(120, Math.floor(h / cellH)));
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

  /**
   * Host-box geometry is authority once getBoundingClientRect is real.
   * Do not max with FitAddon — that blocked focus→pin shrink when Fit still
   * reported the larger focus canvas. Island defense is CSS (flex:1;height:0).
   *
   * `forcePty`: always notify the PTY even when cols×rows match lastGeom
   * (attach/journal remount needs SIGWINCH so TUIs redraw).
   *
   * Always `term.refresh` after a successful measure — pin remount, tab
   * unpark (1×1 → real box with same cols×rows), and dock drag leave the
   * scrollable viewport desynced if we skip paint when geom is unchanged.
   */
  const pushResize = (opts?: { readonly forcePty?: boolean }): void => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;

    const measured = measureHost(host, term);
    if (!measured) return;

    const cols = Math.max(20, Math.min(300, measured.cols));
    const rows = Math.max(5, Math.min(120, measured.rows));

    if (term.cols !== cols || term.rows !== rows) {
      try {
        term.resize(cols, rows);
      } catch {
        return;
      }
    }

    // Re-sync canvas + scroll area even when cols×rows are stable (unpark /
    // pin settle). Without this, wheel scroll and the PTY view go dead after
    // zone moves or tab keep-alive at 1×1.
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore — older paint paths still usable
    }

    const geomChanged =
      lastGeom.current.cols !== cols || lastGeom.current.rows !== rows;
    if (!geomChanged && !opts?.forcePty) {
      setGeomLabel(`${cols}×${rows}`);
      return;
    }
    lastGeom.current = { cols, rows };
    setGeomLabel(`${cols}×${rows}`);

    const lease = leaseRef.current;
    const api = apiRef.current;
    if (lease && api) void api.terminalResize(lease, cols, rows);
  };

  /**
   * Temporary ±1 row then restore — guarantees a PTY resize edge when pin
   * settle lands on a stable geom (manual dock drag fixed the same way).
   */
  const forcePtyNudge = (): void => {
    const term = termRef.current;
    const host = hostRef.current;
    const api = apiRef.current;
    const lease = leaseRef.current;
    if (!term || !host || !api || !lease) return;

    const measured = measureHost(host, term);
    if (!measured) return;

    const cols = Math.max(20, Math.min(300, measured.cols));
    const rows = Math.max(5, Math.min(120, measured.rows));
    const nudgedRows = Math.max(5, rows - 1);

    try {
      term.resize(cols, nudgedRows);
    } catch {
      return;
    }
    void api.terminalResize(lease, cols, nudgedRows);

    requestAnimationFrame(() => {
      if (termRef.current !== term || leaseRef.current !== lease) return;
      try {
        term.resize(cols, rows);
      } catch {
        return;
      }
      void api.terminalResize(lease, cols, rows);
      lastGeom.current = { cols, rows };
      setGeomLabel(`${cols}×${rows}`);
      try {
        term.refresh(0, Math.max(0, rows - 1));
      } catch {
        // ignore
      }
    });
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
    // FitAddon still loaded for xterm internals; host measure is geometry authority.
    const fit = new FitAddon();
    term.loadAddon(fit);
    host.replaceChildren();
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /**
     * Wheel: do NOT capture-phase preventDefault.
     *
     * xterm 6 SmoothScrollableElement bails when `browserEvent.defaultPrevented`
     * is already set (`scrollableElement.ts` `_onMouseWheel`). A capture
     * preventDefault therefore kills normal-buffer scrollback while TUI mouse
     * protocol still looked "handled" — the "fixed but still broken" state.
     *
     * Owners (xterm internals, no custom dual path):
     * - mouse-reporting TUI → CoreMouseService on `.xterm`
     * - alt buffer, no mouse → xterm wheel → cursor up/down
     * - normal scrollback → SmoothScrollableElement
     *
     * Bubble-only: stop scroll chaining into canvas/page after xterm ran.
     */
    const onWheelBubble = (ev: WheelEvent): void => {
      if (ev.ctrlKey || ev.metaKey) return;
      // xterm / SSE already preventDefault when they consume; still block
      // parent scroll when they don't (empty scrollback, edge geometry).
      if (!ev.defaultPrevented) ev.preventDefault();
    };
    host.addEventListener("wheel", onWheelBubble, { passive: false });

    // Keep the xterm textarea focused so key + mouse protocol stay live.
    const onPointerDownCapture = (): void => {
      term.focus();
    };
    host.addEventListener("pointerdown", onPointerDownCapture, { capture: true });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    /** Last real host box — detect pin reflow size jumps. */
    let lastHostBox = { w: 0, h: 0 };
    /** Previous RO sample was parked/invisible (<40px). Unpark needs force fit. */
    let prevHostTiny = true;
    const scheduleResize = (opts?: { readonly forcePty?: boolean }): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushResize(opts);
      }, RESIZE_DEBOUNCE_MS);
    };
    const hardFitBurst = (opts?: { readonly forcePty?: boolean }): void => {
      for (const ms of SETTLE_FITS_MS) {
        settleTimers.push(setTimeout(() => pushResize(opts), ms));
      }
    };

    requestAnimationFrame(() => {
      pushResize();
      hardFitBurst();
    });

    const onWindowResize = (): void => {
      scheduleResize();
    };
    window.addEventListener("resize", onWindowResize);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const w = entry?.contentRect.width ?? host.getBoundingClientRect().width;
      const h = entry?.contentRect.height ?? host.getBoundingClientRect().height;
      const nowReal = w >= 40 && h >= 40;
      const nowTiny = !nowReal;
      // Tab unpark: pane was 1×1 (parked), now real again — even if cols×rows match.
      const grewBack = prevHostTiny && nowReal;
      const sizeJump =
        lastHostBox.w > 0 &&
        nowReal &&
        (Math.abs(w - lastHostBox.w) > 24 || Math.abs(h - lastHostBox.h) > 24);
      prevHostTiny = nowTiny;
      if (nowReal) lastHostBox = { w, h };
      // Pin/dock reflow or unpark: force PTY + settle so scroll/viewport re-sync.
      if (grewBack || sizeJump) {
        hardFitBurst({ forcePty: true });
        scheduleResize({ forcePty: true });
        return;
      }
      scheduleResize();
    });
    observer.observe(host);
    if (root) observer.observe(root);
    // Focus panel + workbench panes reflow on pin/split/stored focusSize.
    const ancestors = [
      root?.closest(".focus-surface__panel"),
      root?.closest(".workbench-pane"),
      root?.closest(".workbench-panes"),
      root?.closest(".work-focus-shell"),
      root?.closest(".work-surface-dock"),
      root?.closest(".dock-slot"),
    ];
    for (const el of ancestors) {
      if (el instanceof Element) observer.observe(el);
    }

    return () => {
      host.removeEventListener("wheel", onWheelBubble);
      host.removeEventListener("pointerdown", onPointerDownCapture, { capture: true });
      window.removeEventListener("resize", onWindowResize);
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
    const settleTimers: ReturnType<typeof setTimeout>[] = [];

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
        // Prefer grid snapshot attach — correct after multi-hour sessions;
        // byte journal is a truncating ring and can cut mid-escape.
        const screenLines = result.screen?.lines;
        if (screenLines && screenLines.length > 0) {
          term.reset();
          // Plain-text rebuild of retained scrollback + viewport.
          term.write(screenLines.join("\r\n"));
          if (result.screen?.seq !== undefined) lastSeq = result.screen.seq;
        } else {
          for (const item of result.journal ?? []) {
            if (item.type === "output" && item.data) term.write(item.data);
            if (item.seq !== undefined) lastSeq = item.seq;
          }
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
        // Journal replayed at prior focus size; force PTY on every settle tick
        // so the shell learns the pinned box, then one ±1-row nudge after layout
        // stabilizes (same effect as a manual dock drag).
        requestAnimationFrame(() => {
          if (!alive) return;
          pushResize({ forcePty: true });
          term.focus();
        });
        for (const ms of SETTLE_FITS_MS) {
          settleTimers.push(
            setTimeout(() => {
              if (alive) pushResize({ forcePty: true });
            }, ms),
          );
        }
        settleTimers.push(
          setTimeout(() => {
            if (alive) forcePtyNudge();
          }, PTY_NUDGE_AFTER_SETTLE_MS),
        );
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : String(error)),
      );

    return () => {
      alive = false;
      offData.dispose();
      offEvent();
      for (const t of settleTimers) clearTimeout(t);
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
  const [killArmed, setKillArmed] = useState(false);
  const killArmTimer = useRef<number | null>(null);
  const closeSurface = () => closeWorkbenchSurface(surfaceId);
  const togglePin = () => {
    if (pinned) unpinWorkbenchSurface(surfaceId);
    else pinWorkbenchSurface(surfaceId);
  };
  const disarmKill = () => {
    if (killArmTimer.current !== null) {
      window.clearTimeout(killArmTimer.current);
      killArmTimer.current = null;
    }
    setKillArmed(false);
  };
  const fireKill = () => {
    if (!killArmed) {
      if (killArmTimer.current !== null) window.clearTimeout(killArmTimer.current);
      setKillArmed(true);
      killArmTimer.current = window.setTimeout(() => {
        killArmTimer.current = null;
        setKillArmed(false);
      }, KILL_ARM_MS);
      return;
    }
    disarmKill();
    void getVellumApi()
      ?.terminalKill?.(bindingId, hostId)
      .then(() => setStatus("exited"));
  };
  const attached = status === "control";

  useEffect(() => {
    return () => {
      if (killArmTimer.current !== null) window.clearTimeout(killArmTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!attached) disarmKill();
  }, [attached]);

  return (
    <div
      ref={rootRef}
      className="native-terminal-surface"
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
              <Button
                size="xs"
                variant="danger"
                title={killArmed ? "click again to kill session" : "arm kill session (3s)"}
                aria-label={killArmed ? "Confirm kill session" : "Kill session"}
                className={killArmed ? "ring-1 ring-crimson/60" : undefined}
                onClick={fireKill}
              >
                {killArmed ? "Confirm" : "Kill"}
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
