import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CanvasNode } from "@shared/canvas";
import type { VellumCommandTerminalApi } from "@shared/ipc";
import { resolveTerminalBinding } from "@shared/terminal";
import { taskBrief } from "@shared/task";
import { MONO_CELL } from "../../lib/focus-measure";
import { use$ } from "@legendapp/state/react";
import {
  closeFocusModalSurface,
  dock$,
  pinWorkbenchSurface,
  terminalSurfaceId,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import {
  VELLUM_XTERM_FONT_FAMILY,
  xtermThemeFor,
} from "../../lib/terminal-theme";
import { attachXtermAppearance } from "../../lib/xterm-appearance";
import { themeMode$ } from "../../lib/theme-mode";
import { cellsForPane, shouldNotifyPtyResize } from "../../lib/terminal-resize";
import {
  bookmarkFromBuffer,
  resolveViewportRestore,
  storeTerminalViewport,
  takeTerminalViewport,
} from "../../lib/terminal-viewport";
import { attachXtermAutoCopy } from "../../lib/xterm-auto-copy";
import { claimedTaskForActorNode } from "../../lib/claimed-task";
import { state$ } from "../../lib/state";
import {
  deadStateCopy,
  isAgentTerminalSeat,
  killActionCopy,
  KILL_ARM_MS,
  type KillUxPhase,
  terminalSurfaceEyebrow,
} from "../../lib/terminal-kill-ux";
import { ensureTerminalRunning } from "../../lib/terminal-actions";
import { onTerminalEvent } from "../../lib/terminal-events";
import {
  initialSessionLoadPhase,
  isSessionLoadActive,
  SESSION_LOAD_STUCK_MS,
  sessionLoadPresentation,
  type SessionLoadPhase,
} from "../../lib/session-load";
import { releaseTaskToQueue } from "../../lib/work-actions";
import { canClaimFocusAfterAsyncWork } from "../../lib/focus-ownership";
import { ActivityMark } from "../ActivityMark";
import { Button, Eyebrow, OverlayHeader } from "../ui";
import { ActorEdgesGlance } from "./ActorEdgesGlance";
import { ActorLedgerPane } from "./ActorLedgerPane";
import { SessionLoadSpinner } from "./SessionLoadSpinner";

type AttachResult = {
  readonly ok: boolean;
  readonly message?: string;
  readonly lease?: { readonly leaseId: string; readonly epoch: string };
  readonly cols?: number;
  readonly rows?: number;
  /** Session status at attach time — retained exited generations still attach. */
  readonly status?: "starting" | "running" | "exited" | string;
  /** Canonical live-session attach: serialized xterm VT state. */
  readonly screen?: {
    readonly bindingId?: string;
    readonly epoch?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly seq?: bigint;
    readonly serialized?: string;
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
 * Trailing window before the child is told a new size. Must outlast the
 * SETTLE_FITS_MS ladder's last step so one open produces one SIGWINCH, not one
 * per settle tick.
 */
const PTY_NOTIFY_SETTLE_MS = 120;

const applyViewportBookmark = (
  term: Terminal,
  bindingId: string,
  epoch: string,
): void => {
  const bookmark = takeTerminalViewport(bindingId, epoch);
  if (!bookmark) return;
  try {
    const restore = resolveViewportRestore(bookmark, term.buffer.active.baseY);
    if (restore === "bottom") term.scrollToBottom();
    else term.scrollToLine(restore);
  } catch {
    // Scroll APIs can throw if the buffer is mid-dispose; content still shows.
  }
};

type XtermCore = {
  readonly _renderService?: {
    readonly dimensions?: {
      readonly css?: {
        readonly cell?: { readonly width?: number; readonly height?: number };
      };
    };
  };
};

/**
 * Terminal geometry diagnostic.
 *
 * xterm measures the character cell during `open()` and its docs require the
 * parent to be visible with real dimensions at that moment. If it is not, the
 * cell metrics are wrong and every later row paint inherits the error, which
 * looks like scrambled/overlapping rows that only settle once something forces
 * a full repaint. This records what the box and the cell actually were, so the
 * question is answered from the real app instead of inferred.
 *
 * Renderer console is captured into the observability ring
 * (installObservabilityConsoleHook -> recordRendererConsole), so these lines
 * are queryable. Grep tag: vellum:term-geom
 */
const logTermGeom = (event: string, data: Record<string, unknown>): void => {
  try {
    console.warn(`[vellum:term-geom] ${event} ${JSON.stringify(data)}`);
  } catch {
    // diagnostics must never break the surface
  }
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
 * Never trust FitAddon or the live .xterm node — both size to the current
 * grid and freeze pin/focus/dock growth. flex:1;height:0 host is the pane.
 */
const measureHost = (
  host: HTMLElement,
  term: Terminal,
): { cols: number; rows: number; w: number; h: number } | null => {
  const hostRect = host.getBoundingClientRect();
  const { cellW, cellH } = readCellSize(term);
  return cellsForPane({
    hostWidth: hostRect.width,
    hostHeight: hostRect.height,
    cellW,
    cellH,
    padX: XTERM_PAD_X,
    padY: XTERM_PAD_Y,
  });
};

export function TerminalSurface({
  node,
  visible = true,
}: {
  readonly node: CanvasNode;
  /** False in parked keep-alive panes — children may pause cosmetic work. */
  readonly visible?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const appearanceRef = useRef<ReturnType<typeof attachXtermAppearance> | null>(
    null,
  );
  const leaseRef = useRef<string | undefined>(undefined);
  const epochRef = useRef<string | undefined>(undefined);
  const apiRef = useRef<VellumCommandTerminalApi | undefined>(undefined);
  const lastGeom = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  /** Trailing timer that coalesces child SIGWINCH into one settled size. */
  const ptyNotifyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState("attaching…");
  const [geomLabel, setGeomLabel] = useState("");
  const [releasePending, setReleasePending] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  /** Bump to re-run attach after Stop → Reopen (same bindingId). */
  const [attachKey, setAttachKey] = useState(0);
  const [killPhase, setKillPhase] = useState<KillUxPhase>("idle");
  const [reopenPending, setReopenPending] = useState(false);
  /** Why the last generation ended, read from the host when the seat is dead. */
  const [deadInfo, setDeadInfo] = useState<{ reason?: string; message?: string }>({});
  const killArmTimer = useRef<number | null>(null);
  /**
   * An agent seat is LAZY. A dead seat is not a broken thing that needs a
   * human to press a button — it is a cold seat, and looking at it is demand.
   * Only an explicit operator Stop keeps it down; everything else wakes.
   */
  const operatorStopped = useRef(false);
  const autoWakes = useRef(0);
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const claimedTask = claimedTaskForActorNode(doc, actorRefs, node.id);
  const binding = resolveTerminalBinding(node);
  const bindingId = binding?.kind === "native" ? binding.bindingId : "";
  const hostId = binding?.kind === "native" ? binding.hostId : "local";
  const agentSeat =
    binding?.kind === "native" ? isAgentTerminalSeat(binding) : false;
  const pinSessionId =
    typeof node.ether?.terminal?.sessionId === "string"
      ? node.ether.terminal.sessionId
      : undefined;
  const [loadPhase, setLoadPhase] = useState<SessionLoadPhase | null>(() =>
    initialSessionLoadPhase({ agentSeat, sessionId: pinSessionId }),
  );
  // Attach effect must not re-run on every canvas node identity change.
  const nodeRef = useRef(node);
  nodeRef.current = node;

  /**
   * Host-box geometry is authority once getBoundingClientRect is real.
   * Do not max with FitAddon — that blocked focus→pin shrink when Fit still
   * reported the larger focus canvas. Island defense is CSS (flex:1;height:0).
   *
   * Always `term.refresh` after a successful measure — pin remount, tab
   * unpark (1×1 → real box with same cols×rows), and dock drag leave the
   * scrollable viewport desynced if we skip paint when geom is unchanged.
   * That renderer-only repaint must never signal the child PTY unless its
   * measured cols×rows genuinely changed.
   */
  const pushResize = (): void => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;

    const measured = measureHost(host, term);
    if (!measured) {
      logTermGeom("measure-rejected", {
        hostW: Math.round(host.getBoundingClientRect().width),
        hostH: Math.round(host.getBoundingClientRect().height),
        termCols: term.cols,
        termRows: term.rows,
      });
      return;
    }

    const cols = Math.max(20, Math.min(300, measured.cols));
    const rows = Math.max(5, Math.min(120, measured.rows));

    {
      const { cellW, cellH } = readCellSize(term);
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const screenW = screen ? Math.round(screen.getBoundingClientRect().width) : -1;
      logTermGeom("resize", {
        measuredW: Math.round(measured.w),
        measuredH: Math.round(measured.h),
        cellW: Number(cellW.toFixed(3)),
        cellH: Number(cellH.toFixed(3)),
        cellIsFallback:
          Math.abs(cellW - FALLBACK_CELL_W) < 0.001 && Math.abs(cellH - FALLBACK_CELL_H) < 0.001,
        cols,
        rows,
        termCols: term.cols,
        termRows: term.rows,
        // The painted screen vs the character grid it is supposed to be. CSS
        // forces .xterm-screen to width:100%, so a gap here means backgrounds
        // and rows are painted to a different width than the grid.
        screenW,
        gridW: Math.round(cols * cellW),
        screenGridDeltaPx: screenW < 0 ? -1 : Math.round(screenW - cols * cellW),
        // What the PTY was last TOLD. The child wraps at this width, xterm
        // paints at termCols. If they diverge, the harness breaks its lines at
        // a column the renderer is not painting — the reported symptom where a
        // word splits mid-token onto the next row.
        ptyCols: lastGeom.current.cols,
        ptyRows: lastGeom.current.rows,
        ptyDiverged: lastGeom.current.cols !== cols || lastGeom.current.rows !== rows,
      });
    }

    // Tell the CHILD first, then paint. A TUI positions its output by absolute
    // row/column using the size the PTY reports, so if xterm is resized first
    // the child keeps writing against the old geometry and lands its status
    // line in the middle of the scrollback (proved in
    // e2e/scenarios/terminal-absolute-row.spec.ts: told 30 rows, painted 39,
    // status line rendered 9 rows above the bottom). Ordering the SIGWINCH
    // ahead of the local resize closes that window instead of widening it.
    {
      const lease = leaseRef.current;
      const api = apiRef.current;
      const nextGeom = { cols, rows };
      if (!lease || !api) {
        logTermGeom("pty-notify-skipped", { cols, rows, hasLease: Boolean(lease), hasApi: Boolean(api) });
      } else if (shouldNotifyPtyResize(lastGeom.current, nextGeom)) {
        // COALESCE. Opening a surface runs pushResize through the whole
        // SETTLE_FITS_MS ladder plus ResizeObserver ticks, and each distinct
        // geometry used to become its own SIGWINCH — measured at four per open
        // (135x30, 136x30, 137x30, 137x39). Every SIGWINCH makes a full-screen
        // TUI clear and repaint at that geometry, so four of them in flight
        // repaint over each other and leave the wreckage on screen.
        //
        // The local xterm resize stays immediate so the surface still feels
        // responsive; only the child notification waits for layout to settle,
        // and only the final size is ever sent.
        if (ptyNotifyTimer.current !== undefined) clearTimeout(ptyNotifyTimer.current);
        ptyNotifyTimer.current = setTimeout(() => {
          ptyNotifyTimer.current = undefined;
          const liveLease = leaseRef.current;
          const liveApi = apiRef.current;
          if (!liveLease || !liveApi) return;
          if (!shouldNotifyPtyResize(lastGeom.current, nextGeom)) return;
          void (async () => {
            try {
              // Record the belief only once the child has actually accepted the
              // size — setting it up front means a dropped or dead-lease resize
              // is remembered as delivered and never retried.
              const ok = (await liveApi.terminalResize(liveLease, cols, rows)) !== false;
              logTermGeom("pty-notify", { cols, rows, lease: liveLease.slice(0, 8), ok });
              if (!ok) return;
              lastGeom.current = nextGeom;
              // ONLY NOW paint the new grid. A real terminal resizes its grid
              // and signals the child atomically; here the two are separated by
              // IPC, so the local resize waits for the child's acknowledgement.
              // Resizing first opens a window where the child positions output
              // by absolute row against a height nobody is painting, and that
              // output is written into the scrollback permanently.
              const live = termRef.current;
              if (!live) return;
              if (live.cols !== cols || live.rows !== rows) {
                try {
                  live.resize(cols, rows);
                } catch {
                  return;
                }
              }
              try {
                live.refresh(0, Math.max(0, live.rows - 1));
              } catch {
                // older paint paths still usable
              }
            } catch {
              logTermGeom("pty-notify-failed", { cols, rows });
            }
          })();
        }, PTY_NOTIFY_SETTLE_MS);
      } else if (term.cols !== cols || term.rows !== rows) {
        // Child already agrees on this geometry (e.g. a remount painting the
        // size it was last told) — safe to size the grid locally.
        try {
          term.resize(cols, rows);
        } catch {
          return;
        }
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

    setGeomLabel(`${cols}×${rows}`);
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
      theme: xtermThemeFor(themeMode$.peek()),
    });
    // FitAddon still loaded for xterm internals; host measure is geometry authority.
    const fit = new FitAddon();
    term.loadAddon(fit);
    host.replaceChildren();
    // The measurement moment. xterm requires the parent to be visible with real
    // dimensions here; a 0-size or not-yet-laid-out box poisons the cell metrics
    // for the life of this terminal.
    const openRect = host.getBoundingClientRect();
    term.open(host);
    {
      const { cellW, cellH } = readCellSize(term);
      logTermGeom("open", {
        hostW: Math.round(openRect.width),
        hostH: Math.round(openRect.height),
        hostVisible: openRect.width > 0 && openRect.height > 0,
        connected: host.isConnected,
        cellW: Number(cellW.toFixed(3)),
        cellH: Number(cellH.toFixed(3)),
        // true => xterm's own measurement was unavailable and a guess is in use
        cellIsFallback:
          Math.abs(cellW - FALLBACK_CELL_W) < 0.001 && Math.abs(cellH - FALLBACK_CELL_H) < 0.001,
        termCols: term.cols,
        termRows: term.rows,
      });
    }
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

    // Drag-select → system clipboard on mouseup (shared with herdr PTY).
    const detachAutoCopy = attachXtermAutoCopy(host, term);

    // Live appearance protocol: OSC 10/11 via xterm theme; CSI ?996n / ?2031
    // / live ?997 reports. Policy from settings (follow Vellum Command default).
    const agentAppearance =
      state$.settings.peek().appearance.agentAppearance === "agent"
        ? "agent"
        : "follow";
    const appearance = attachXtermAppearance(term, {
      initialMode: themeMode$.peek(),
      policy: agentAppearance,
    });
    appearanceRef.current = appearance;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    /** Last real host box — detect pin reflow size jumps. */
    let lastHostBox = { w: 0, h: 0 };
    /** Previous RO sample was parked/invisible (<40px). Unpark needs force fit. */
    let prevHostTiny = true;
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
      // Pin/dock reflow or unpark: settle the local viewport. pushResize only
      // signals the child if the measured terminal geometry actually changed.
      if (grewBack || sizeJump) {
        hardFitBurst();
        scheduleResize();
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
      detachAutoCopy();
      host.removeEventListener("wheel", onWheelBubble);
      host.removeEventListener("pointerdown", onPointerDownCapture, { capture: true });
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const t of settleTimers) clearTimeout(t);
      appearance.dispose();
      appearanceRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Live theme swap: re-apply Vellum Command palette + optional CSI ?997 report.
  useEffect(
    () =>
      themeMode$.onChange(({ value }) => {
        appearanceRef.current?.setMode(value);
      }),
    [],
  );

  useEffect(() => {
    const api = getVellumCommandApi() as VellumCommandTerminalApi | undefined;
    const term = termRef.current;
    apiRef.current = api;
    if (!api || !term || !bindingId) {
      setStatus("terminal unavailable");
      setLoadPhase(null);
      return;
    }
    let alive = true;
    const pending: LiveEvent[] = [];
    let attachDone = false;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    // Agent seats: starting|resuming → attaching (finding when pin unknown).
    // Geography shells: attaching only.
    const startPhase = initialSessionLoadPhase({
      agentSeat,
      sessionId: pinSessionId,
    });
    setLoadPhase(startPhase);
    setStatus(
      sessionLoadPresentation({
        phase: startPhase,
        sessionId: pinSessionId,
      }).label,
    );
    // Long ensure/attach without progress → stuck chrome (crimson).
    const stuckTimer = window.setTimeout(() => {
      if (!alive || attachDone) return;
      setLoadPhase((prev) => (prev != null ? "stuck" : prev));
      setStatus(
        sessionLoadPresentation({
          phase: "stuck",
          sessionId: pinSessionId,
        }).label,
      );
    }, SESSION_LOAD_STUCK_MS);

    const discardPending = (): void => {
      pending.length = 0;
    };

    const clearLoad = (): void => {
      window.clearTimeout(stuckTimer);
      setLoadPhase(null);
    };

    const offData = term.onData((data) => {
      const lease = leaseRef.current;
      if (lease) void api.terminalWrite(lease, data);
    });

    // Do NOT wire term.onResize → PTY. pushResize is the only path.

    const offEvent = onTerminalEvent((raw) => {
      const event = raw as LiveEvent;
      if (event.bindingId !== bindingId) return;
      if (!attachDone) {
        // Never drop post-snapshot events: attachScreen only covers bytes
        // captured at snapshot start; pending is the sole gap-fill path.
        // A stuck attach is bounded by cleanup/fail, not by discarding PTY data.
        pending.push(event);
        return;
      }
      if (event.epoch !== epochRef.current) return;
      if (event.type === "output" && event.data) term.write(event.data);
      if (event.type === "exit") {
        // Lazy seat: a generation ending is not the seat ending. Unless the
        // operator stopped it, re-attach (which re-ensures a live generation)
        // rather than latching a dead card the operator has to dismiss.
        setStatus("exited");
        setKillPhase("stopped");
        setLoadPhase(null);
      }
    });

    const runAttach = (): void => {
      if (!alive) return;
      setLoadPhase((prev) => (prev === "stuck" ? "stuck" : "attaching"));
      setStatus(
        sessionLoadPresentation({
          phase: "attaching",
          sessionId: pinSessionId,
        }).label,
      );
      void api
        .terminalAttach({ bindingId, mode: "control", takeover: true, hostId })
        .then((raw) => {
          const result = raw as AttachResult;
          if (!alive) {
            if (result.ok && result.lease)
              void api.terminalRelease(result.lease.leaseId);
            discardPending();
            return;
          }
          if (!result.ok || !result.lease) {
            setStatus(result.message ?? "not running");
            attachDone = true;
            clearLoad();
            discardPending();
            epochRef.current = undefined;
            return;
          }
          leaseRef.current = result.lease.leaseId;
          epochRef.current = result.lease.epoch;
          // The child's geometry is UNKNOWN until this surface has told it.
          // Seeding from the session snapshot records what the child was at
          // some earlier moment, and if the pane has since changed size the
          // gate reads "no change" and the SIGWINCH is never sent — the child
          // then positions output against a size nobody is painting. Starting
          // at 0 makes the first measurement always notify.
          lastGeom.current = { cols: 0, rows: 0 };
          let lastSeq: bigint | undefined;
          // Live sessions have exactly one attach representation: serialized VT
          // state. Journal is only for failures before an observer existed.
          const serializedScreen = result.screen?.serialized;
          const finishAttach = (): void => {
            if (!alive || !result.lease) return;
            applyViewportBookmark(term, bindingId, result.lease.epoch);
            attachDone = true;
            let sawExit = result.status === "exited";
            for (const event of pending) {
              if (event.epoch !== result.lease.epoch) continue;
              if (
                lastSeq !== undefined &&
                event.seq !== undefined &&
                event.seq <= lastSeq
              )
                continue;
              if (event.type === "output" && event.data) term.write(event.data);
              if (event.type === "exit") sawExit = true;
            }
            discardPending();
            // An attach that lands on an EXITED generation is not a dead seat.
            // ensureTerminalRunning ran just above, and createAgentSeat only
            // reuses a record that is still alive — so re-running the attach
            // spawns a fresh generation. That is precisely what the Reopen
            // button does (it sets killPhase idle and bumps attachKey, nothing
            // more), which is why Reopen always worked while the first open
            // painted a dead card over a seat that was never broken.
            //
            // An agent seat is lazy: opening it IS the demand signal, so it
            // recovers itself instead of asking for a click. Bounded so a seat
            // that genuinely cannot start still settles into the stopped state.
            // A failed resume is not a dead seat. When a resume generation dies
            // with harness proof the session is gone, the host mints a fresh pin
            // and respawns it (local-host maybeFailOpenAfterResumeFailure,
            // deferred via queueMicrotask). The attach we just finished can land
            // on that dying resume generation, so declaring the seat dead here
            // races a replacement already on its way — which is exactly why
            // Reopen looked instant: the new generation was ALREADY running, and
            // the click only re-attached to it.
            //
            // Wait for a generation with a DIFFERENT epoch before giving up, and
            // hold the loading state so nothing flashes in between.
            if (sawExit && agentSeat && !operatorStopped.current) {
              const deadEpoch = result.lease.epoch;
              void (async () => {
                const deadline = Date.now() + 8_000;
                while (alive && Date.now() < deadline) {
                  const live = await api
                    .terminalGet?.(bindingId, hostId)
                    .catch(() => undefined);
                  const status = live?.status;
                  const epoch = (live as { readonly epoch?: string } | undefined)?.epoch;
                  if (
                    (status === "running" || status === "starting") &&
                    epoch !== undefined &&
                    epoch !== deadEpoch
                  ) {
                    if (!alive) return;
                    setKillPhase("idle");
                    setAttachKey((key) => key + 1);
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 200));
                }
                if (!alive) return;
                setStatus("exited");
                setKillPhase("stopped");
                setLoadPhase(null);
              })();
              return;
            }
            // Retained exited generations may expose their final raw journal.
            // Never paint those as a live control lease.
            setStatus(sawExit ? "exited" : "control");
            setKillPhase(sawExit ? "stopped" : "idle");
            clearLoad();
            // Repaint through layout settle; only a real cols×rows transition is
            // forwarded to the child PTY.
            requestAnimationFrame(() => {
              if (!alive) return;
              pushResize();
              if (
                !sawExit &&
                canClaimFocusAfterAsyncWork(hostRef.current)
              ) {
                term.focus();
              }
            });
            for (const ms of SETTLE_FITS_MS) {
              settleTimers.push(
                setTimeout(() => {
                  if (alive) pushResize();
                }, ms),
              );
            }
          };
          if (serializedScreen) {
            // Serialized xterm VT state restores cells, SGR/color, cursor,
            // normal/alternate buffers, and terminal modes in one representation.
            // Viewport restore must wait for write's parse callback.
            // Size the grid to the SNAPSHOT before replaying it. Serialized VT
            // carries hard-wrapped rows and absolute cursor positions recorded
            // at the captured geometry; replaying it into a differently sized
            // grid mangles those rows. This is a local-only resize — the child
            // is not involved, so it does not go through the ack-then-paint
            // path that user-driven resizes use.
            const snapCols = result.screen?.cols;
            const snapRows = result.screen?.rows;
            if (
              typeof snapCols === "number" &&
              typeof snapRows === "number" &&
              snapCols > 0 &&
              snapRows > 0 &&
              (term.cols !== snapCols || term.rows !== snapRows)
            ) {
              try {
                term.resize(snapCols, snapRows);
              } catch {
                // fall through — replay into the current grid
              }
            }
            term.reset();
            if (result.screen?.seq !== undefined) lastSeq = result.screen.seq;
            term.write(serializedScreen, finishAttach);
          } else {
            // Journal path: concatenate then one write so finishAttach runs after
            // the parser drains (same contract as serialized replay).
            const chunks: string[] = [];
            for (const item of result.journal ?? []) {
              if (item.type === "output" && item.data) chunks.push(item.data);
              if (item.seq !== undefined) lastSeq = item.seq;
            }
            const journalOutput = chunks.join("");
            if (journalOutput.length > 0) term.write(journalOutput, finishAttach);
            else finishAttach();
          }
        })
        .catch((error: unknown) => {
          if (!alive) return;
          setStatus(error instanceof Error ? error.message : String(error));
          attachDone = true;
          clearLoad();
          discardPending();
          epochRef.current = undefined;
        });
    };

    // Actor seats: ensure generation first (spinner covers ensure + attach).
    // Geography shells only attach (ensure already ran in openTerminal).
    if (agentSeat) {
      /**
       * Wait for the host to actually hold a LIVE generation before attaching.
       *
       * ensureTerminalRunning resolves as soon as create returns, but the new
       * generation is not necessarily the one a lookup by bindingId answers
       * with yet — so attaching immediately can bind to the previous, exited
       * generation and paint the seat dead. Retrying at full speed just hits
       * the same instant three times; clicking Reopen "worked" only because a
       * human takes a second, by which point the live generation is there.
       *
       * Polling the host removes the race instead of racing faster.
       */
      const awaitLiveGeneration = async (): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (alive && Date.now() < deadline) {
          const live = await api.terminalGet?.(bindingId, hostId).catch(() => undefined);
          const status = live?.status;
          if (status === "running" || status === "starting") return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      };
      void ensureTerminalRunning(nodeRef.current, { resume: true }).then(
        async (result) => {
          if (!alive) return;
          if (!result.ok) {
            setStatus(result.message);
            attachDone = true;
            clearLoad();
            setKillPhase("stopped");
            return;
          }
          await awaitLiveGeneration();
          if (!alive) return;
          runAttach();
        },
      );
    } else {
      runAttach();
    }

    return () => {
      alive = false;
      window.clearTimeout(stuckTimer);
      // Only bookmark a fully attached surface. Mid-attach store would overwrite
      // a good pin bookmark with empty-buffer state and lose scroll position.
      if (attachDone && termRef.current === term) {
        const epoch = epochRef.current;
        if (epoch && bindingId) {
          try {
            const buf = term.buffer.active;
            storeTerminalViewport(
              bindingId,
              bookmarkFromBuffer(epoch, buf.viewportY, buf.baseY),
            );
          } catch {
            // Term may already be mid-dispose.
          }
        }
      }
      offData.dispose();
      offEvent();
      for (const t of settleTimers) clearTimeout(t);
      discardPending();
      const lease = leaseRef.current;
      leaseRef.current = undefined;
      epochRef.current = undefined;
      if (lease) void api.terminalRelease(lease);
    };
  }, [bindingId, hostId, attachKey, agentSeat]);

  const label = node.type === "text" ? node.text : "terminal";
  const surfaceId = terminalSurfaceId(node.id);
  const pinned = use$(() =>
    dock$.registry.surfaces.get().find((surface) => surface.id === surfaceId)?.zone === "pinned",
  );
  // Modal semantics: dismisses the whole chrome-less focus stack (cycled
  // mirror views park behind the front pane), one press. Views only.
  const closeSurface = () => closeFocusModalSurface(surfaceId);
  const togglePin = () => {
    if (pinned) unpinWorkbenchSurface(surfaceId);
    else pinWorkbenchSurface(surfaceId);
  };
  const disarmKill = () => {
    if (killArmTimer.current !== null) {
      window.clearTimeout(killArmTimer.current);
      killArmTimer.current = null;
    }
    setKillPhase((phase) => (phase === "armed" ? "idle" : phase));
  };
  const fireKill = () => {
    if (killPhase === "stopping" || killPhase === "stopped") return;
    if (killPhase !== "armed") {
      if (killArmTimer.current !== null) window.clearTimeout(killArmTimer.current);
      setKillPhase("armed");
      killArmTimer.current = window.setTimeout(() => {
        killArmTimer.current = null;
        setKillPhase((phase) => (phase === "armed" ? "idle" : phase));
      }, KILL_ARM_MS);
      return;
    }
    if (killArmTimer.current !== null) {
      window.clearTimeout(killArmTimer.current);
      killArmTimer.current = null;
    }
    // The operator asked for this one to stay down. This is the only thing
    // that suppresses the lazy wake below.
    operatorStopped.current = true;
    setKillPhase("stopping");
    setStatus("stopping…");
    void getVellumCommandApi()
      ?.terminalKill?.(bindingId, hostId)
      .then(() => {
        setKillPhase("stopped");
        setStatus("exited");
      })
      .catch((error: unknown) => {
        setKillPhase("idle");
        setStatus(error instanceof Error ? error.message : String(error));
      });
  };
  const reopenProcess = async (): Promise<void> => {
    if (reopenPending) return;
    operatorStopped.current = false;
    autoWakes.current = 0;
    setReopenPending(true);
    // Agent seats: attach effect owns ensure + load spinner. Geography shells
    // still ensure here so attach finds a live generation.
    try {
      if (!agentSeat) {
        setLoadPhase("starting");
        setStatus(
          sessionLoadPresentation({ phase: "starting", sessionId: pinSessionId })
            .label,
        );
        const result = await ensureTerminalRunning(node, { resume: false });
        if (!result.ok) {
          setStatus(result.message);
          setKillPhase("stopped");
          setLoadPhase(null);
          return;
        }
      }
      setKillPhase("idle");
      setLoadPhase(
        initialSessionLoadPhase({ agentSeat, sessionId: pinSessionId }),
      );
      setStatus(
        sessionLoadPresentation({
          phase: initialSessionLoadPhase({ agentSeat, sessionId: pinSessionId }),
          sessionId: pinSessionId,
        }).label,
      );
      setAttachKey((key) => key + 1);
    } finally {
      setReopenPending(false);
    }
  };
  const attached = status === "control";
  const processDead = status === "exited" || killPhase === "stopped";
  const processStopping = killPhase === "stopping" || status === "stopping…";
  const showDeadOverlay = processDead || processStopping;
  const showLoadOverlay =
    isSessionLoadActive(loadPhase) && !showDeadOverlay && !attached;
  const loadPresentation = isSessionLoadActive(loadPhase)
    ? sessionLoadPresentation({ phase: loadPhase, sessionId: pinSessionId })
    : null;
  const killCopy = killActionCopy({
    phase: processDead
      ? "stopped"
      : processStopping
        ? "stopping"
        : killPhase === "armed"
          ? "armed"
          : "idle",
    agentSeat,
  });
  const deadCopy = deadStateCopy({ agentSeat });
  /**
   * The real reason this generation ended: the harness's exit message, the
   * classified exit reason, or whatever the last status said. The generic
   * headline alone gives the operator nothing to act on.
   */
  const deadReason = [deadInfo.reason, deadInfo.message, status !== "exited" ? status : ""]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" — ")
    .slice(0, 300);
  const releaseClaim = async (): Promise<void> => {
    if (!claimedTask || releasePending) return;
    setReleasePending(true);
    setReleaseError("");
    try {
      const result = await releaseTaskToQueue(
        canvasName,
        claimedTask.sinkNodeId,
        claimedTask.task.id,
      );
      if (result && !result.ok) setReleaseError(result.message);
    } catch (cause) {
      setReleaseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReleasePending(false);
    }
  };

  useEffect(() => {
    return () => {
      if (killArmTimer.current !== null) window.clearTimeout(killArmTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!attached) disarmKill();
  }, [attached]);

  useEffect(() => {
    if (status !== "exited" && killPhase !== "stopped") return;
    if (!bindingId) return;
    let alive = true;
    void getVellumCommandApi()
      ?.terminalGet?.(bindingId, hostId)
      .then((live) => {
        if (!alive || !live) return;
        setDeadInfo({
          ...(live.exitReason ? { reason: live.exitReason } : {}),
          ...(live.exitMessage ? { message: live.exitMessage } : {}),
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [status, killPhase, bindingId, hostId]);

  useEffect(() => {
    if (status !== "exited") return;
    // Lazy wake: the seat died with the app, crashed, or was never started in
    // this process — it does not matter which. Opening it is the demand signal,
    // so bring it back instead of painting a dead end. Bounded so a seat that
    // cannot start (missing CLI, bad launch) still settles into the stopped
    // state rather than spinning.
    if (agentSeat && !operatorStopped.current && autoWakes.current < 2) {
      autoWakes.current += 1;
      setKillPhase("idle");
      setLoadPhase(initialSessionLoadPhase({ agentSeat, sessionId: pinSessionId }));
      setStatus(
        sessionLoadPresentation({
          phase: initialSessionLoadPhase({ agentSeat, sessionId: pinSessionId }),
          sessionId: pinSessionId,
        }).label,
      );
      setAttachKey((key) => key + 1);
      return;
    }
    setKillPhase("stopped");
    setLoadPhase(null);
  }, [status, agentSeat, pinSessionId]);

  return (
    <div
      ref={rootRef}
      className={[
        "native-terminal-surface",
        showDeadOverlay ? "native-terminal-surface--dead" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <OverlayHeader
        eyebrow={terminalSurfaceEyebrow(hostId)}
        title={label}
        status={
          <span className="native-terminal-surface__status inline-flex items-center gap-1.5">
            {showLoadOverlay && loadPresentation ? (
              <SessionLoadSpinner
                variant="inline"
                phase={loadPresentation.phase}
                sessionId={pinSessionId}
              />
            ) : (
              <>
                <ActivityMark
                  mode={attached ? "static" : "wave"}
                  tone={processDead || processStopping ? "crimson" : "amber"}
                  size="inline"
                  label={status}
                />
                {status}
              </>
            )}
            {geomLabel && attached ? ` - ${geomLabel}` : ""}
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
                title={killCopy.title}
                aria-label={killCopy.ariaLabel}
                disabled={killCopy.disabled}
                className={killPhase === "armed" ? "ring-1 ring-crimson/60" : undefined}
                onClick={fireKill}
              >
                {killCopy.label}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="primary"
              title="Close view — process keeps running"
              aria-label="Close view"
              onClick={closeSurface}
            >
              Close
            </Button>
          </>
        }
      />
      {claimedTask ? (
        <div
          className="flex items-center gap-2 border-b border-stroke bg-cyan/[0.045] px-3 py-1.5 text-[11px]"
          role="status"
        >
          <span className="shrink-0 uppercase tracking-[0.12em] text-cyan">
            Claimed task
          </span>
          <strong className="min-w-0 flex-1 truncate text-ink">
            {taskBrief(claimedTask.task)}
          </strong>
          {releaseError ? (
            <span className="max-w-[32ch] truncate text-crimson" title={releaseError}>
              {releaseError}
            </span>
          ) : null}
          <Button
            size="xs"
            variant="subtle"
            disabled={releasePending}
            onClick={() => void releaseClaim()}
          >
            {releasePending ? "Releasing…" : "Unclaim"}
          </Button>
        </div>
      ) : null}
      {/* Body: ledger pane LEFT (focus only), xterm stage, edges pane RIGHT —
          one modal plate. The pinned dock keeps just the connections pane. */}
      <div className="native-terminal-surface__body">
        {!pinned ? <ActorLedgerPane node={node} visible={visible} /> : null}
        <div className="native-terminal-surface__stage">
          <div
            ref={hostRef}
            className={[
              "native-terminal-surface__xterm",
              showDeadOverlay ? "native-terminal-surface__xterm--dim" : "",
              showLoadOverlay ? "native-terminal-surface__xterm--dim" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden={showDeadOverlay || showLoadOverlay || undefined}
          />
          {showLoadOverlay && loadPresentation ? (
            <div className="native-terminal-surface__load">
              <SessionLoadSpinner
                phase={loadPresentation.phase}
                sessionId={pinSessionId}
              />
            </div>
          ) : null}
          {showDeadOverlay ? (
            <div
              className="native-terminal-surface__dead"
              role="status"
              aria-live="polite"
            >
              <div className="native-terminal-surface__dead-card">
                <Eyebrow tone="amber">
                  {processStopping ? "stopping" : "ended"}
                </Eyebrow>
                <strong className="native-terminal-surface__dead-title">
                  {processStopping ? "Stopping process…" : deadCopy.headline}
                </strong>
                <p className="native-terminal-surface__dead-detail">
                  {processStopping
                    ? "Stopping the process…"
                    : deadCopy.detail}
                </p>
                {/* Why it ended. Without this the card says "Agent stopped" and
                    hides the harness's own error behind the overlay, so a seat
                    that cannot start looks identical to one that was stopped on
                    purpose — and there is nothing to act on. */}
                {!processStopping && deadReason ? (
                  <p className="native-terminal-surface__dead-detail font-mono text-[11px] opacity-80">
                    {deadReason}
                  </p>
                ) : null}
                {!processStopping ? (
                  <div className="native-terminal-surface__dead-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={reopenPending}
                      onClick={() => void reopenProcess()}
                    >
                      {reopenPending ? "Opening…" : deadCopy.reopenLabel}
                    </Button>
                    <Button
                      size="sm"
                      variant="chrome"
                      title="Close view only"
                      onClick={closeSurface}
                    >
                      {deadCopy.closeViewLabel}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <ActorEdgesGlance node={node} zone={pinned ? "pinned" : "focus"} />
      </div>
    </div>
  );
}
