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
  closeWorkbenchSurface,
  dock$,
  pinWorkbenchSurface,
  terminalSurfaceId,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { surfaceById } from "../../lib/surface-registry";
import { getVellumCommandApi } from "../../lib/vellum-api";
import {
  VELLUM_XTERM_FONT_FAMILY,
  xtermThemeFor,
} from "../../lib/terminal-theme";
import { attachXtermAppearance } from "../../lib/xterm-appearance";
import { themeMode$ } from "../../lib/theme-mode";
import { shouldNotifyPtyResize } from "../../lib/terminal-resize";
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
import { ActivityMark } from "../ActivityMark";
import { Button, Eyebrow, OverlayHeader } from "../ui";
import { ActorEdgesGlance } from "./ActorEdgesGlance";
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
  const appearanceRef = useRef<ReturnType<typeof attachXtermAppearance> | null>(
    null,
  );
  const leaseRef = useRef<string | undefined>(undefined);
  const epochRef = useRef<string | undefined>(undefined);
  const apiRef = useRef<VellumCommandTerminalApi | undefined>(undefined);
  const lastGeom = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const [status, setStatus] = useState("attaching…");
  const [geomLabel, setGeomLabel] = useState("");
  const [releasePending, setReleasePending] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  /** Bump to re-run attach after Stop → Reopen (same bindingId). */
  const [attachKey, setAttachKey] = useState(0);
  const [killPhase, setKillPhase] = useState<KillUxPhase>("idle");
  const [reopenPending, setReopenPending] = useState(false);
  const killArmTimer = useRef<number | null>(null);
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

    setGeomLabel(`${cols}×${rows}`);

    const lease = leaseRef.current;
    const api = apiRef.current;
    if (!lease || !api) return;

    const nextGeom = { cols, rows };
    if (!shouldNotifyPtyResize(lastGeom.current, nextGeom)) return;

    lastGeom.current = nextGeom;
    void api.terminalResize(lease, cols, rows);
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

    // Drag-select → system clipboard on mouseup (shared with herdr PTY).
    const detachAutoCopy = attachXtermAutoCopy(host, term);

    // Live appearance protocol: OSC 10/11 via xterm theme; CSI ?996n / ?2031
    // / live ?997 reports. Policy from settings (follow Vellum Command default).
    const agentAppearance =
      state$.settings.appearance.agentAppearance?.peek() === "agent"
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

  // Live theme swap: re-apply Vellum palette + optional CSI ?997 report.
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
          lastGeom.current = {
            cols: result.screen?.cols ?? result.cols ?? 0,
            rows: result.screen?.rows ?? result.rows ?? 0,
          };
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
              if (!sawExit) term.focus();
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
      void ensureTerminalRunning(nodeRef.current, { resume: true }).then(
        (result) => {
          if (!alive) return;
          if (!result.ok) {
            setStatus(result.message);
            attachDone = true;
            clearLoad();
            setKillPhase("stopped");
            return;
          }
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
  }, [bindingId, hostId, attachKey, agentSeat, pinSessionId]);

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
    if (status === "exited") {
      setKillPhase("stopped");
      setLoadPhase(null);
    }
  }, [status]);

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
      {/* Edges nested under the top bar (same plate as xterm); also when pinned. */}
      <ActorEdgesGlance node={node} />
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
    </div>
  );
}
