import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { CanvasNode } from "@shared/canvas";
import type { JuntoTerminalApi } from "@shared/ipc";
import { resolveTerminalBinding, type TerminalOutputBatch } from "@shared/terminal";
import { terminalSettings, type TerminalSettings } from "@shared/settings";
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
import { getJuntoApi } from "../../lib/junto-api";
import { xtermThemeFor } from "../../lib/terminal-theme";
import { attachXtermAppearance } from "../../lib/xterm-appearance";
import { themeMode$ } from "../../lib/theme-mode";
import { shouldPresentTerminalFrames } from "../../lib/terminal-paint-lease";
import {
  cellsForPane,
  ptyNotifyDelayMs,
  ptyNotifyShouldRetry,
  shouldNotifyPtyResize,
  shouldPaintView,
  UNKNOWN_TERMINAL_GEOMETRY,
} from "../../lib/terminal-resize";
import {
  bookmarkFromBuffer,
  resolveViewportRestore,
  storeTerminalViewport,
  takeTerminalViewport,
} from "../../lib/terminal-viewport";
import { attachXtermAutoCopy } from "../../lib/xterm-auto-copy";
import { playAlert } from "../../lib/sfx";
import { claimedTaskForActorNode } from "../../lib/claimed-task";
import { state$ } from "../../lib/state";
import {
  deadStateCopy,
  killActionCopy,
  KILL_ARM_MS,
  type KillUxPhase,
  terminalSurfaceEyebrow,
} from "../../lib/terminal-kill-ux";
import { ensureTerminalRunning } from "../../lib/terminal-actions";
import { seatDeadReason } from "../../lib/seat-recovery";
import { onTerminalEvent } from "../../lib/terminal-events";
import { actorRailsOpen, terminal$ } from "../../lib/terminal-state";
import {
  initialSessionLoadPhase,
  isSessionLoadActive,
  SESSION_LOAD_STUCK_MS,
  sessionLoadPresentation,
  startedSessionLoadPhase,
  type SessionLoadPhase,
} from "../../lib/session-load";
import { TASKS_ENABLED } from "@shared/features";
import { releaseTaskToQueue } from "../../lib/work-actions";
import {
  claimFocus,
  shouldClaimFocusOnSurfaceOpen,
} from "../../lib/focus-ownership";
import { ActivityMark } from "../ActivityMark";
import { Button, Eyebrow, OverlayHeader } from "../ui";
import { OverseerMark } from "../OverseerMark";
import { isOverseerSeat } from "../../lib/overseer-set";
import { ActorEdgesGlance } from "./ActorEdgesGlance";
import { ActorLedgerPane } from "./ActorLedgerPane";
import { SessionLoadSpinner } from "./SessionLoadSpinner";
import { AgentPortrait } from "../AgentPortrait";
import { HarnessMark } from "../HarnessMark";
import { GRID_CELL_CHROME } from "../../lib/terminal-grid";
import { isHarnessId } from "@shared/managed-terminal-templates";

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

type LiveEvent = TerminalOutputBatch | {
  readonly bindingId: string;
  readonly epoch: string;
  readonly type: "resize" | "exit" | "session" | "seat-state";
  readonly seq?: bigint;
};

/** Must match CSS padding on `.native-terminal-surface__xterm .xterm`. */
const XTERM_PAD_X = 16; // 8 + 8
const XTERM_PAD_Y = 12; // 6 + 6
/** Debounce layout thrash from pin/focus/dock animations. */
const RESIZE_DEBOUNCE_MS = 48;
/** After open/attach, wait for focus-shell enter + stored size apply. */
const SETTLE_FITS_MS = [0, 50, 160, 320, 600] as const;

/**
 * Which renderer is painting this surface. Diagnosis only — never a
 * user-facing surface and never product copy.
 */
export type TerminalRendererKind = "webgl" | "dom";

/**
 * Written on the surface root and the xterm host so the active renderer is
 * readable from devtools and from an e2e page query, without a UI affordance.
 */
export const TERMINAL_RENDERER_ATTR = "data-junto-term-renderer";

/** The only two addon members this surface drives. */
type WebglHandle = {
  readonly dispose: () => void;
  readonly onContextLoss: (listener: () => void) => { readonly dispose: () => void };
};

export type WebglRendererDeps<A extends WebglHandle> = {
  /** Construct the addon. Throws where WebGL2 is unavailable. */
  readonly create: () => A;
  /** Hand it to xterm. Activation is synchronous once the terminal is open, and throws when the GL context cannot be built. */
  readonly load: (addon: A) => void;
  /** Renderer actually in effect — at attach, and again if the context is lost. */
  readonly report: (
    kind: TerminalRendererKind,
    detail: Record<string, unknown>,
  ) => void;
};

export type WebglRendererAttachment = {
  /** Renderer in effect immediately after the attach attempt. */
  readonly kind: TerminalRendererKind;
  readonly dispose: () => void;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Guarded GPU attach.
 *
 * Renderer paint is the terminal's scrolling bottleneck, so WebGL is the
 * wanted renderer — but every failure path has to end on a *live* terminal,
 * never a dead one. Three ways it can fail, all landing on xterm's default
 * renderer: the constructor throws (unsupported browser), activation throws
 * (no GL context), or the GL context is lost later. The last one is why
 * disposing matters: xterm's WebGL addon restores the default renderer inside
 * its own dispose, so a lost context that is never disposed leaves a surface
 * that has stopped repainting.
 *
 * One shot. A lost context never re-arms WebGL, so a flapping GPU cannot put
 * the surface in an attach loop.
 */
export const attachWebglRenderer = <A extends WebglHandle>(
  deps: WebglRendererDeps<A>,
): WebglRendererAttachment => {
  let addon: A | undefined;
  let lossSub: { readonly dispose: () => void } | undefined;
  let released = false;

  const release = (): void => {
    released = true;
    try {
      lossSub?.dispose();
    } catch {
      // Teardown must never break the surface.
    }
    try {
      addon?.dispose();
    } catch {
      // Teardown must never break the surface.
    }
    lossSub = undefined;
    addon = undefined;
  };

  const fallBack = (stage: string, error?: unknown): void => {
    if (released) return;
    release();
    deps.report(
      "dom",
      error === undefined ? { stage } : { stage, error: describeError(error) },
    );
  };

  try {
    addon = deps.create();
    // Subscribe before activation: the addon owns the emitter from
    // construction, and a loss during activation must not be missed.
    lossSub = addon.onContextLoss(() => fallBack("context-loss"));
    deps.load(addon);
  } catch (error) {
    fallBack("activate", error);
    return { kind: "dom", dispose: () => {} };
  }

  deps.report("webgl", { stage: "active" });
  return {
    kind: "webgl",
    dispose: () => {
      if (released) return;
      release();
    },
  };
};

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
 * Alt-held fast scroll, as a multiple of the operator's normal gesture.
 *
 * Travel per gesture is a durable preference now (settings.terminal
 * scrollSensitivity, StateEngine behind IPC — never renderer storage, which is
 * what tests/settings-state-architecture.test.ts holds). Only the *ratio*
 * between a normal gesture and an alt-held one stays a constant here: it is a
 * feel relationship, not a second knob.
 */
const SCROLL_FAST_MULTIPLE = 5;

/**
 * Wheel fan-out for TUIs that own the wheel (mouse tracking on — Claude Code).
 *
 * xterm's CoreMouseService emits exactly ONE wheel-button report per DOM wheel
 * event no matter what scrollSensitivity says: MouseService._sendEvent runs the
 * sensitivity-scaled line math and then discards the magnitude, keeping only
 * the direction. The TUI scrolls its fixed per-report amount, so the
 * preference is dead precisely on the surface the operator scrolls most.
 * Normal-buffer agents feel the option because the viewport scroller applies
 * it natively — that asymmetry is the bug this closes.
 *
 * The cure: fan the gesture out
 * into N whole notches. Each notch re-enters xterm as its own wheel event and
 * produces one report through xterm's own protocol encoder — CoreMouseService
 * stays the only writer of mouse bytes.
 *
 * Sensitivity means "reports per wheel notch". Trackpads accumulate
 * cell-height steps with xterm's own 0.3 damping so sensitivity 1 matches the
 * native feel at the handoff, and the fraction carries between events so slow
 * gestures still move. A direction flip drops the carried fraction — a
 * reversed gesture must not spend the tail of the previous one.
 */
const WHEEL_NOTCH_PX = 120;
/** xterm's isLikelyTrackpad discriminator: per-event |deltaY| under this. */
const WHEEL_TRACKPAD_DELTA_MAX = 50;
const WHEEL_TRACKPAD_DAMP = 0.3;
/** Momentum bursts at max sensitivity must not flood the PTY. */
const WHEEL_MAX_REPORTS_PER_EVENT = 60;

export type WheelFanout = {
  /** Signed whole reports to synthesize for this event. */
  readonly reports: number;
  /** Fraction carried into the next event. */
  readonly partial: number;
};

export const wheelReportFanout = (input: {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly altFast: boolean;
  readonly sensitivity: number;
  readonly cellHeight: number;
  readonly partial: number;
}): WheelFanout => {
  const speed = input.sensitivity * (input.altFast ? SCROLL_FAST_MULTIPLE : 1);
  let steps: number;
  if (input.deltaMode === 1) {
    // DOM_DELTA_LINE — already whole lines.
    steps = input.deltaY;
  } else if (Math.abs(input.deltaY) < WHEEL_TRACKPAD_DELTA_MAX) {
    steps =
      (input.deltaY / Math.max(input.cellHeight, 1)) * WHEEL_TRACKPAD_DAMP;
  } else {
    steps = input.deltaY / WHEEL_NOTCH_PX;
  }
  const carried =
    Math.sign(input.partial) === -Math.sign(steps) ? 0 : input.partial;
  const total = carried + steps * speed;
  // + 0 folds Math.trunc's -0 away so callers compare against plain 0.
  const whole = Math.trunc(total) + 0;
  const reports = Math.max(
    -WHEEL_MAX_REPORTS_PER_EVENT,
    Math.min(WHEEL_MAX_REPORTS_PER_EVENT, whole),
  );
  return { reports, partial: total - whole };
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
 * are queryable. Grep tag: junto:term-geom
 */
const logTermGeom = (event: string, data: Record<string, unknown>): void => {
  try {
    console.warn(`[junto:term-geom] ${event} ${JSON.stringify(data)}`);
  } catch {
    // diagnostics must never break the surface
  }
};

export type CellSize = { readonly cellW: number; readonly cellH: number };

/**
 * Cell guess for the window where xterm has not measured the font yet.
 *
 * It has to track the preference: at fontSize 24 a 13px guess measures the
 * pane at nearly twice the real column count, and that wrong cols×rows is what
 * the child PTY would be told first.
 *
 * An approximation by construction — the advance-width ratio is the house mono
 * stack's, and xterm adds letterSpacing in device pixels. Real measurement
 * replaces it as soon as open() lands.
 */
export const fallbackCell = (prefs: TerminalSettings): CellSize => ({
  cellW: prefs.fontSize * MONO_CELL.ratio + prefs.letterSpacing,
  cellH: prefs.fontSize * prefs.lineHeight,
});

const readCellSize = (term: Terminal, fallback: CellSize): CellSize => {
  const core = term as unknown as { _core?: XtermCore };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  const cellW = cell?.width && cell.width > 1 ? cell.width : fallback.cellW;
  const cellH = cell?.height && cell.height > 1 ? cell.height : fallback.cellH;
  return { cellW, cellH };
};

const isFallbackCell = (measured: CellSize, fallback: CellSize): boolean =>
  Math.abs(measured.cellW - fallback.cellW) < 0.001 &&
  Math.abs(measured.cellH - fallback.cellH) < 0.001;

/**
 * The xterm options this surface drives from durable settings.
 *
 * One shape for both moments — the constructor call and every later live
 * write — so an already-open terminal cannot drift from a freshly opened one.
 * Everything absent here stays xterm's own default.
 */
export type ManagedTerminalOptions = {
  readonly scrollSensitivity: number;
  readonly fastScrollSensitivity: number;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly cursorStyle: TerminalSettings["cursorStyle"];
  readonly scrollback: number;
  readonly cursorBlink: boolean;
  readonly minimumContrastRatio: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly screenReaderMode: boolean;
};

type MutableTerminalOptions = {
  -readonly [K in keyof ManagedTerminalOptions]: ManagedTerminalOptions[K];
};

export const MANAGED_TERMINAL_OPTIONS = [
  "scrollSensitivity",
  "fastScrollSensitivity",
  "fontSize",
  "fontFamily",
  "cursorStyle",
  "scrollback",
  "cursorBlink",
  "minimumContrastRatio",
  "lineHeight",
  "letterSpacing",
  "screenReaderMode",
] as const satisfies ReadonlyArray<keyof ManagedTerminalOptions>;

/**
 * Options that move the measured character cell. xterm re-measures and clears
 * its renderer on its own for these (CharSizeService, RenderService), but it
 * keeps the SAME cols×rows — so the pane now fits a different number of cells
 * and only a re-fit corrects the grid and the child PTY.
 */
export const METRIC_TERMINAL_OPTIONS = [
  "fontSize",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
] as const satisfies ReadonlyArray<keyof ManagedTerminalOptions>;

/**
 * Preferences → xterm options.
 *
 * cursorBlink is the one composite: the preference GATES the surface's
 * visibility-driven blink, it does not replace it. False here means never
 * blink — an operator who turned it off for photosensitivity must not see it
 * come back when the pane is focused.
 */
export const managedTerminalOptions = (
  prefs: TerminalSettings,
  surface: { readonly visible: boolean },
): ManagedTerminalOptions => ({
  scrollSensitivity: prefs.scrollSensitivity,
  fastScrollSensitivity: prefs.scrollSensitivity * SCROLL_FAST_MULTIPLE,
  fontSize: prefs.fontSize,
  fontFamily: prefs.fontFamily,
  cursorStyle: prefs.cursorStyle,
  scrollback: prefs.scrollback,
  cursorBlink: prefs.cursorBlink && surface.visible,
  minimumContrastRatio: prefs.minimumContrastRatio,
  lineHeight: prefs.lineHeight,
  letterSpacing: prefs.letterSpacing,
  screenReaderMode: prefs.screenReaderMode,
});

export type TerminalOptionsWrite = {
  readonly changed: ReadonlyArray<keyof ManagedTerminalOptions>;
  readonly metricsChanged: boolean;
  readonly scrollbackChanged: boolean;
  readonly scrollbackShrank: boolean;
};

const assignOption = <K extends keyof ManagedTerminalOptions>(
  options: Partial<MutableTerminalOptions>,
  key: K,
  value: ManagedTerminalOptions[K],
): void => {
  options[key] = value;
};

/**
 * Write the changed options onto a live terminal, and only those.
 *
 * Every write to `term.options` fires xterm's option-change listeners — a
 * metric write clears the renderer and re-measures, a scrollback write resizes
 * both buffers. Writing the whole set on every settings broadcast would do all
 * of that for an unrelated edit to, say, audio volume.
 */
export const writeManagedTerminalOptions = (
  target: { readonly options: Partial<MutableTerminalOptions> },
  next: ManagedTerminalOptions,
): TerminalOptionsWrite => {
  const options = target.options;
  const previousScrollback = options.scrollback;
  const changed: Array<keyof ManagedTerminalOptions> = [];
  for (const key of MANAGED_TERMINAL_OPTIONS) {
    if (options[key] === next[key]) continue;
    assignOption(options, key, next[key]);
    changed.push(key);
  }
  const scrollbackChanged = changed.includes("scrollback");
  return {
    changed,
    metricsChanged: changed.some((key) =>
      (METRIC_TERMINAL_OPTIONS as ReadonlyArray<string>).includes(key),
    ),
    scrollbackChanged,
    scrollbackShrank:
      scrollbackChanged &&
      typeof previousScrollback === "number" &&
      next.scrollback < previousScrollback,
  };
};

/**
 * What a scrollback write costs the viewport.
 *
 * Read from xterm's own buffer code, not from the docs: shrinking scrollback
 * re-resizes the buffer, and the shrink path trims from the TOP
 * (`lines.trimStart`, then `ybase`/`ydisp` reduced by the same amount, clamped
 * at 0) — Buffer.resize, @xterm/xterm 6.1.0-beta.302. The live screen and the
 * newest scrollback therefore always survive; what moves is where the viewport
 * is pointing. Two consequences the surface has to answer for:
 *
 * - ydisp is mutated in place with no scroll event, and cols×rows did not
 *   change, so nothing schedules a repaint — the rows on screen can be stale.
 *   Any scrollback write ends in a forced paint.
 * - a viewport that was following the live output can be clamped off the
 *   bottom. Re-pin it. A viewport parked up in history is left where xterm put
 *   it — yanking an operator who is reading back is worse than the drift.
 */
export type ScrollbackRepair = "none" | "repaint" | "scroll to bottom";

export const scrollbackRepair = (input: {
  readonly changed: boolean;
  readonly shrank: boolean;
  readonly atBottom: boolean;
}): ScrollbackRepair =>
  !input.changed
    ? "none"
    : input.shrank && input.atBottom
      ? "scroll to bottom"
      : "repaint";

/** How the surface answers xterm's onBell. "off" subscribes to nothing. */
export type BellResponse = "none" | "flash" | "sound";

export const bellResponse = (bell: TerminalSettings["bell"]): BellResponse => {
  switch (bell) {
    case "visual":
      return "flash";
    case "sound":
      return "sound";
    default:
      return "none";
  }
};

/** The live-terminal surface applyTerminalPreferences drives. */
export type LiveTerminalTarget = {
  readonly options: Partial<MutableTerminalOptions>;
  readonly buffer: {
    readonly active: { readonly viewportY: number; readonly baseY: number };
  };
  readonly scrollToBottom: () => void;
};

export type TerminalPrefsApplication = {
  readonly write: TerminalOptionsWrite;
  readonly repair: ScrollbackRepair;
  readonly refitted: boolean;
};

/**
 * Apply durable preferences to an already-open terminal.
 *
 * The whole decision lives here so opening a terminal and editing a preference
 * on an open one run the same code: write what changed, repair the viewport a
 * scrollback write disturbed, and re-push geometry when the cell metrics moved.
 * `refit` and `refitBurst` are the surface's existing resize path — this
 * function never measures anything itself.
 */
export const applyTerminalPreferences = (
  prefs: TerminalSettings,
  deps: {
    readonly term: LiveTerminalTarget;
    readonly visible: boolean;
    /** Re-measure the pane and re-push geometry — one immediate pass. */
    readonly refit: () => void;
    /** Settle ladder for the layout that follows a cell-metric change. */
    readonly refitBurst: () => void;
  },
): TerminalPrefsApplication => {
  let atBottom = true;
  try {
    const buffer = deps.term.buffer.active;
    atBottom = buffer.viewportY >= buffer.baseY;
  } catch {
    // Buffer can throw mid-dispose; treat it as following the live output.
  }
  const write = writeManagedTerminalOptions(
    deps.term,
    managedTerminalOptions(prefs, { visible: deps.visible }),
  );
  const repair = scrollbackRepair({
    changed: write.scrollbackChanged,
    shrank: write.scrollbackShrank,
    atBottom,
  });
  if (repair === "scroll to bottom") {
    try {
      deps.term.scrollToBottom();
    } catch {
      // Scroll APIs throw mid-dispose; the forced paint below still runs.
    }
  }
  const refitted = write.metricsChanged || repair !== "none";
  if (refitted) deps.refit();
  if (write.metricsChanged) deps.refitBurst();
  return { write, repair, refitted };
};

/**
 * Geometry authority: host box → cols×rows.
 * Never trust FitAddon or the live .xterm node — both size to the current
 * grid and freeze pin/focus/dock growth. flex:1;height:0 host is the pane.
 */
const measureHost = (
  host: HTMLElement,
  term: Terminal,
  fallback: CellSize,
  pad: { readonly x: number; readonly y: number },
): { cols: number; rows: number; w: number; h: number } | null => {
  const hostRect = host.getBoundingClientRect();
  const { cellW, cellH } = readCellSize(term, fallback);
  return cellsForPane({
    hostWidth: hostRect.width,
    hostHeight: hostRect.height,
    cellW,
    cellH,
    padX: pad.x,
    padY: pad.y,
  });
};

/** xterm inset per presentation. Must match the `.xterm` inset in styles.css. */
const XTERM_PAD = { x: XTERM_PAD_X, y: XTERM_PAD_Y } as const;
const GRID_XTERM_PAD = { x: GRID_CELL_CHROME.padX, y: GRID_CELL_CHROME.padY } as const;

export function TerminalSurface({
  node,
  visible = true,
  grid,
}: {
  readonly node: CanvasNode;
  /** False in parked keep-alive panes — children may pause cosmetic work. */
  readonly visible?: boolean;
  /**
   * Present while a grid focus cell holds this terminal: compact chrome, no
   * context pane, and a grid-only font size. View options only; dropping it
   * restores the operator's own settings and refits.
   */
  readonly grid?: { readonly fontSize: number };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const appearanceRef = useRef<ReturnType<typeof attachXtermAppearance> | null>(
    null,
  );
  const gpuRef = useRef<WebglRendererAttachment | null>(null);
  /** Activate / context-loss never re-arm, including after a visibility lease. */
  const webglBlockedRef = useRef(false);
  /**
   * Durable terminal preferences, as last applied to this surface. Read
   * through terminalSettings(): an installed settings row written before the
   * terminal fragment existed has no `terminal` key, and absence means
   * "today's terminal", not "no terminal".
   */
  const prefsRef = useRef<TerminalSettings>(
    terminalSettings(state$.settings.peek()),
  );
  const gridRef = useRef(grid);
  gridRef.current = grid;
  /** Durable preferences with the grid view's font size laid over them. */
  const livePrefs = (): TerminalSettings =>
    gridRef.current
      ? { ...prefsRef.current, fontSize: gridRef.current.fontSize }
      : prefsRef.current;
  /** Live xterm.onBell subscription, plus the bell mode it was opened for. */
  const bellRef = useRef<{ readonly dispose: () => void } | null>(null);
  const bellModeRef = useRef<TerminalSettings["bell"] | null>(null);
  const bellFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Settle ladder owned by the preference path (the attach path has its own). */
  const prefFitTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const leaseRef = useRef<string | undefined>(undefined);
  const epochRef = useRef<string | undefined>(undefined);
  const apiRef = useRef<JuntoTerminalApi | undefined>(undefined);
  /** Last geometry the spawn-host child acked. View paint does not wait on this. */
  const lastAcked = useRef({ ...UNKNOWN_TERMINAL_GEOMETRY });
  const desiredGeom = useRef({ ...UNKNOWN_TERMINAL_GEOMETRY });
  /** Failed/false child notifies for the current desired size. Reset on ack or new geom. */
  const ptyNotifyFailCount = useRef(0);
  const notifyInFlight = useRef(false);
  /** Async resize replies belong to one attachment, even when refs survive it. */
  const resizeGeneration = useRef(0);
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
   * An agent seat is LAZY: opening a cold seat is demand, so the attach effect
   * starts it. A generation that dies while open is different: it settles at
   * once with the host's reason, and Reopen is the operator's retry. Only
   * the host's own fail-open replacement is followed without a click.
   */
  const operatorStopped = useRef(false);
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const claimedTask = claimedTaskForActorNode(doc, actorRefs, node.id);
  const agentSeat = node.ether?.entity?.kind === "agent";
  // Control classification comes from the node kind, never optional binding
  // fields. The exact actor surface is validated separately before its
  // binding can reach attach/occupy.
  const actorSurface = agentSeat ? actorDeliverySurfaceOf(node) : undefined;
  const binding = resolveTerminalBinding(node);
  const bindingId = agentSeat
    ? actorSurface?.bindingId ?? ""
    : binding?.kind === "native"
      ? binding.bindingId
      : "";
  const hostId = agentSeat
    ? actorSurface?.hostId ?? "local"
    : binding?.kind === "native"
      ? binding.hostId
      : "local";
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
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  /**
   * Host-box geometry is authority once getBoundingClientRect is real.
   * Do not max with FitAddon — that blocked focus→pin shrink when Fit still
   * reported the larger focus canvas. Island defense is CSS (flex:1;height:0).
   *
   * `term.refresh` only on a real cols×rows change or an explicit force
   * (unpark / size jump / attach settle). A stable ResizeObserver tick
   * must not full-repaint the xterm canvas — that is a GPU wake on every
   * layout flicker while a stream is already dirtying the same surface.
   * Renderer-only repaint must never signal the child PTY unless measured
   * cols×rows genuinely changed.
   */
  const pushResize = (opts?: { readonly forcePaint?: boolean }): void => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;

    const fallback = fallbackCell(livePrefs());
    const measured = measureHost(
      host,
      term,
      fallback,
      gridRef.current ? GRID_XTERM_PAD : XTERM_PAD,
    );
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

    const geomChanged = shouldPaintView(
      { cols: term.cols, rows: term.rows },
      { cols, rows },
    );
    if (geomChanged || opts?.forcePaint) {
      const { cellW, cellH } = readCellSize(term, fallback);
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const screenW = screen ? Math.round(screen.getBoundingClientRect().width) : -1;
      logTermGeom("resize", {
        measuredW: Math.round(measured.w),
        measuredH: Math.round(measured.h),
        cellW: Number(cellW.toFixed(3)),
        cellH: Number(cellH.toFixed(3)),
        cellIsFallback: isFallbackCell({ cellW, cellH }, fallback),
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
        ptyCols: lastAcked.current.cols,
        ptyRows: lastAcked.current.rows,
        ptyDiverged: lastAcked.current.cols !== cols || lastAcked.current.rows !== rows,
        forcePaint: opts?.forcePaint === true,
      });
    }

    // View geometry is the pane. Placement (local IPC vs Mini hop) only
    // notifies the child. Waiting on that hop to paint is what froze Remote
    // seats as cream while the label already showed the new grid.
    const nextGeom = { cols, rows };
    if (
      desiredGeom.current.cols !== nextGeom.cols ||
      desiredGeom.current.rows !== nextGeom.rows
    ) {
      ptyNotifyFailCount.current = 0;
    }
    desiredGeom.current = nextGeom;
    if (geomChanged) {
      try {
        term.resize(cols, rows);
      } catch {
        return;
      }
    }
    if (geomChanged || opts?.forcePaint) {
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // ignore — older paint paths still usable
      }
    }
    setGeomLabel((prev) => {
      const next = `${cols}×${rows}`;
      return prev === next ? prev : next;
    });

    const flushChildNotify = (): void => {
      if (notifyInFlight.current) return;
      const desired = desiredGeom.current;
      const lease = leaseRef.current;
      const api = apiRef.current;
      if (!lease || !api) {
        logTermGeom("pty-notify-skipped", {
          cols: desired.cols,
          rows: desired.rows,
          hasLease: Boolean(lease),
          hasApi: Boolean(api),
        });
        return;
      }
      if (!shouldNotifyPtyResize(lastAcked.current, desired)) return;
      const generation = resizeGeneration.current;
      const current = (): boolean =>
        resizeGeneration.current === generation &&
        leaseRef.current === lease && apiRef.current === api;
      notifyInFlight.current = true;
      void (async () => {
        const send = desiredGeom.current;
        try {
          const ok =
            (await api.terminalResize(lease, send.cols, send.rows)) !== false;
          if (!current()) return;
          logTermGeom("pty-notify", {
            cols: send.cols,
            rows: send.rows,
            lease: lease.slice(0, 8),
            ok,
          });
          if (ok) {
            lastAcked.current = send;
            ptyNotifyFailCount.current = 0;
          } else if (
            send.cols === desiredGeom.current.cols &&
            send.rows === desiredGeom.current.rows
          ) {
            ptyNotifyFailCount.current += 1;
          }
        } catch {
          if (!current()) return;
          logTermGeom("pty-notify-failed", { cols: send.cols, rows: send.rows });
          if (
            send.cols === desiredGeom.current.cols &&
            send.rows === desiredGeom.current.rows
          ) {
            ptyNotifyFailCount.current += 1;
          }
        } finally {
          if (current()) {
            notifyInFlight.current = false;
            if (
              shouldNotifyPtyResize(lastAcked.current, desiredGeom.current) &&
              ptyNotifyShouldRetry(ptyNotifyFailCount.current)
            ) {
              scheduleChildNotify();
            }
          }
        }
      })();
    };

    const scheduleChildNotify = (): void => {
      const generation = resizeGeneration.current;
      if (ptyNotifyTimer.current !== undefined) clearTimeout(ptyNotifyTimer.current);
      ptyNotifyTimer.current = setTimeout(() => {
        if (resizeGeneration.current !== generation) return;
        ptyNotifyTimer.current = undefined;
        flushChildNotify();
      }, ptyNotifyDelayMs(lastAcked.current, ptyNotifyFailCount.current));
    };

    if (shouldNotifyPtyResize(lastAcked.current, nextGeom)) scheduleChildNotify();
  };

  const reportRenderer = (
    kind: TerminalRendererKind,
    detail: Record<string, unknown>,
  ): void => {
    try {
      hostRef.current?.setAttribute(TERMINAL_RENDERER_ATTR, kind);
      rootRef.current?.setAttribute(TERMINAL_RENDERER_ATTR, kind);
    } catch {
      // diagnostics must never break the surface
    }
    logTermGeom("renderer", { renderer: kind, ...detail });
  };

  /**
   * Presenting is leased to on-screen seats. Dispose the WebGL addon when the
   * pane is hidden so a keep-alive xterm cannot composite GPU frames; the
   * default renderer keeps the buffer live for PTY writes. Reattach uses the
   * same guarded path as first open. A failed GPU never re-arms.
   */
  const applyWebglLease = (present: boolean): void => {
    const term = termRef.current;
    if (!term) return;
    if (!present) {
      gpuRef.current?.dispose();
      gpuRef.current = null;
      reportRenderer("dom", { stage: "lease-paused" });
      return;
    }
    if (gpuRef.current?.kind === "webgl") return;
    if (webglBlockedRef.current) return;
    const gpu = attachWebglRenderer({
      create: () => new WebglAddon(),
      load: (addon) => term.loadAddon(addon),
      report: (kind, detail) => {
        if (kind === "dom") {
          gpuRef.current = null;
          if (detail.stage === "activate" || detail.stage === "context-loss") {
            webglBlockedRef.current = true;
          }
        }
        reportRenderer(kind, detail);
      },
    });
    gpuRef.current = gpu.kind === "webgl" ? gpu : null;
    if (gpu.kind !== "webgl") return;
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // Buffer is still live; the next write paints.
    }
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host) return;

    // Preferences at construction. The settings bridge hydrates from main
    // asynchronously, so a terminal opened during boot is built from the
    // defaults and corrected by the live effect below when the row lands —
    // the same path an operator edit takes.
    prefsRef.current = terminalSettings(state$.settings.peek());
    const prefs = livePrefs();
    const term = new Terminal({
      ...managedTerminalOptions(prefs, { visible: visibleRef.current }),
      allowProposedApi: true,
      theme: xtermThemeFor(themeMode$.peek()),
    });
    // FitAddon still loaded for xterm internals; host measure is geometry authority.
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Read-only screen-text registries for tests: under the WebGL renderer the
    // DOM carries no text, so e2e reads the buffer through these instead of
    // .xterm-rows. Display-only — no write path, no capability.
    // __juntoTermScreenText: the visible viewport (live composer/footer).
    // __juntoTermTranscriptText: the WHOLE buffer including scrollback — the
    // only witness for counts across a scrolling session (paste duplication).
    const screenTextRegistry = (
      window as unknown as {
        __juntoTermScreenText?: Map<string, () => string>;
        __juntoTermTranscriptText?: Map<string, () => string>;
      }
    );
    screenTextRegistry.__juntoTermScreenText ??= new Map();
    screenTextRegistry.__juntoTermTranscriptText ??= new Map();
    const screenTextKey = bindingId || `surface-${Math.random().toString(36).slice(2)}`;
    screenTextRegistry.__juntoTermScreenText.set(screenTextKey, () => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < term.rows; row += 1) {
        rows.push(
          buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
        );
      }
      return rows.join("\n");
    });
    screenTextRegistry.__juntoTermTranscriptText.set(screenTextKey, () => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < buffer.length; row += 1) {
        rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
      }
      return rows.join("\n");
    });
    host.replaceChildren();
    // The measurement moment. xterm requires the parent to be visible with real
    // dimensions here; a 0-size or not-yet-laid-out box poisons the cell metrics
    // for the life of this terminal.
    const openRect = host.getBoundingClientRect();
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    // GPU paint. Measured: renderer paint, not the PTY backend, is what costs
    // during hard scrolling, and the DOM renderer amplifies whatever a TUI
    // repaints. Attach after open() so activation is synchronous — before
    // open() the addon defers itself to xterm's onWillOpen, and the guard
    // never sees the failure it is there to catch. Hidden keep-alive seats
    // skip attach; applyWebglLease reattaches when the pane is visible.
    applyWebglLease(
      shouldPresentTerminalFrames({ visible: visibleRef.current }),
    );
    {
      const openFallback = fallbackCell(prefs);
      const { cellW, cellH } = readCellSize(term, openFallback);
      logTermGeom("open", {
        hostW: Math.round(openRect.width),
        hostH: Math.round(openRect.height),
        hostVisible: openRect.width > 0 && openRect.height > 0,
        connected: host.isConnected,
        cellW: Number(cellW.toFixed(3)),
        cellH: Number(cellH.toFixed(3)),
        // true => xterm's own measurement was unavailable and a guess is in use
        cellIsFallback: isFallbackCell({ cellW, cellH }, openFallback),
        termCols: term.cols,
        termRows: term.rows,
      });
    }

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

    /**
     * Sensitivity for mouse-reporting TUIs — see wheelReportFanout. Only
     * active when the app owns the wheel AND the operator raised the knob;
     * everywhere else xterm's native handling stands (return true). Synthetic
     * notches are marked so their re-entry passes straight through — each one
     * becomes exactly one report via xterm's own encoder.
     */
    const syntheticWheel = new WeakSet<Event>();
    let wheelPartial = 0;
    term.attachCustomWheelEventHandler((ev) => {
      if (syntheticWheel.has(ev)) return true;
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return true;
      if (ev.deltaY === 0) return true;
      if (term.modes.mouseTrackingMode === "none") {
        wheelPartial = 0;
        return true;
      }
      const sensitivity = term.options.scrollSensitivity ?? 1;
      if (sensitivity <= 1) return true;
      const { reports, partial } = wheelReportFanout({
        deltaY: ev.deltaY,
        deltaMode: ev.deltaMode,
        altFast: ev.altKey,
        sensitivity,
        cellHeight: readCellSize(term, fallbackCell(prefs)).cellH,
        partial: wheelPartial,
      });
      wheelPartial = partial;
      const direction = reports > 0 ? 1 : -1;
      for (let i = Math.abs(reports); i > 0; i--) {
        const notch = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: ev.clientX,
          clientY: ev.clientY,
          deltaY: direction * WHEEL_NOTCH_PX,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        });
        syntheticWheel.add(notch);
        ev.target?.dispatchEvent(notch);
      }
      return false;
    });

    // Keep the xterm textarea focused so key + mouse protocol stay live.
    const onPointerDownCapture = (event: PointerEvent): void => {
      claimFocus(term.textarea ?? host, "gesture", { event, via: term, owner: host });
    };
    host.addEventListener("pointerdown", onPointerDownCapture, { capture: true });

    // Copy-on-select is explicit opt-in because it replaces the user's system
    // clipboard. Read live settings so toggling it does not require a restart.
    const detachAutoCopy = attachXtermAutoCopy(
      host,
      term,
      undefined,
      () => terminalSettings(state$.settings.peek()).copyOnSelect === true,
    );

    // Live appearance protocol: OSC 10/11 via xterm theme; CSI ?996n / ?2031
    // / live ?997 reports. Policy from settings (follow Junto default).
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
        settleTimers.push(setTimeout(() => pushResize({ forcePaint: true }), ms));
      }
    };

    requestAnimationFrame(() => {
      pushResize({ forcePaint: true });
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
      if (ptyNotifyTimer.current !== undefined) {
        clearTimeout(ptyNotifyTimer.current);
        ptyNotifyTimer.current = undefined;
      }
      for (const t of settleTimers) clearTimeout(t);
      appearance.dispose();
      appearanceRef.current = null;
      // Before term.dispose(): the addon's own teardown reaches back into the
      // terminal's render service.
      gpuRef.current?.dispose();
      gpuRef.current = null;
      webglBlockedRef.current = false;
      screenTextRegistry.__juntoTermScreenText?.delete(screenTextKey);
      screenTextRegistry.__juntoTermTranscriptText?.delete(screenTextKey);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Live theme swap: re-apply Junto palette + optional CSI ?997 report.
  useEffect(
    () =>
      themeMode$.onChange(({ value }) => {
        appearanceRef.current?.setMode(value);
      }),
    [],
  );

  /**
   * Visual bell: a short ring on the surface plate.
   *
   * Inline outline rather than a class, so the flash needs nothing from the
   * stylesheet and cannot be left stuck on by a missed transition end.
   */
  const flashBell = (): void => {
    const root = rootRef.current;
    if (!root) return;
    if (bellFlashTimer.current !== undefined) clearTimeout(bellFlashTimer.current);
    root.style.outline = "2px solid currentColor";
    root.style.outlineOffset = "-2px";
    bellFlashTimer.current = setTimeout(() => {
      bellFlashTimer.current = undefined;
      root.style.outline = "";
      root.style.outlineOffset = "";
    }, 120);
  };

  const releaseBell = (): void => {
    try {
      bellRef.current?.dispose();
    } catch {
      // The terminal may already be disposed; teardown must never throw.
    }
    bellRef.current = null;
  };

  /**
   * xterm 6 has no bell option, only an onBell event, so the response is this
   * surface's. "off" holds no subscription at all — today's behaviour.
   */
  const applyBellPreference = (bell: TerminalSettings["bell"]): void => {
    if (bellModeRef.current === bell) return;
    bellModeRef.current = bell;
    releaseBell();
    const response = bellResponse(bell);
    if (response === "none") return;
    const term = termRef.current;
    if (!term) return;
    bellRef.current = term.onBell(() => {
      if (response === "flash") flashBell();
      // Mute and per-clip volume are the audio settings' business.
      else playAlert("attention");
    });
  };

  /** Settle ladder after a cell-metric change; a newer change replaces it. */
  const prefRefitBurst = (): void => {
    for (const timer of prefFitTimers.current) clearTimeout(timer);
    prefFitTimers.current = SETTLE_FITS_MS.map((ms) =>
      setTimeout(() => pushResize({ forcePaint: true }), ms),
    );
  };

  const applyTerminalPrefs = (prefs: TerminalSettings): void => {
    prefsRef.current = prefs;
    const term = termRef.current;
    if (!term) return;
    applyBellPreference(prefs.bell);
    const applied = applyTerminalPreferences(livePrefs(), {
      term,
      visible: visibleRef.current,
      // The one geometry path. A cell-metric change keeps xterm's cols×rows
      // while the pane now fits a different number of them, so the grid and
      // the child PTY are corrected exactly the way a pane resize corrects
      // them.
      refit: () => pushResize({ forcePaint: true }),
      refitBurst: prefRefitBurst,
    });
    if (applied.write.changed.length === 0) return;
    logTermGeom("settings", {
      changed: [...applied.write.changed],
      metrics: applied.write.metricsChanged,
      scrollback: applied.repair,
    });
  };

  /**
   * Live preferences. Terminal settings live in the StateEngine and reach this
   * window over the settings broadcast (lib/settings-state.ts), so an edit has
   * to land on an already-open terminal — closing and reopening a seat to pick
   * up a font size is not a setting taking effect.
   */
  useEffect(() => {
    applyTerminalPrefs(terminalSettings(state$.settings.peek()));
    const off = state$.settings.onChange(() => {
      applyTerminalPrefs(terminalSettings(state$.settings.peek()));
    });
    return () => {
      off();
      for (const timer of prefFitTimers.current) clearTimeout(timer);
      prefFitTimers.current = [];
      if (bellFlashTimer.current !== undefined) {
        clearTimeout(bellFlashTimer.current);
        bellFlashTimer.current = undefined;
      }
      releaseBell();
      bellModeRef.current = null;
    };
  }, []);

  // Grid focus enter, leave, or re-fit: lay the grid font over (or lift it
  // off) the live options, then refit through the settle ladder so cols x rows
  // and the child PTY follow the new cell and inset. Leaving restores the
  // operator's own options; nothing here touches durable settings.
  const gridFontSize = grid?.fontSize;
  const inGrid = grid !== undefined;
  const gridSeenRef = useRef(false);
  useEffect(() => {
    if (!inGrid && !gridSeenRef.current) return;
    gridSeenRef.current = inGrid;
    applyTerminalPrefs(prefsRef.current);
    prefRefitBurst();
  }, [inGrid, gridFontSize]);

  // Focus-zone open / unpark: put the xterm textarea under the keyboard so
  // the operator can type immediately. Opening is the opt-in; later retries
  // wait for slot adoption into the shell and stop if they have already
  // chosen another control inside the modal.
  useEffect(() => {
    const term = termRef.current;
    // Blink is visibility AND preference: a hidden pane stops forcing repaints,
    // and an operator who turned blinking off never gets it back on focus.
    if (term) applyTerminalPrefs(prefsRef.current);
    applyWebglLease(shouldPresentTerminalFrames({ visible }));
    if (!visible) return;
    if (!term) return;
    const claim = (): boolean => {
      const host = hostRef.current;
      if (!host?.closest(".work-focus-shell")) return false;
      if (!shouldClaimFocusOnSurfaceOpen(host)) return true;
      return claimFocus(term.textarea ?? host, "open", { via: term, owner: host });
    };
    if (claim()) return;
    const raf = requestAnimationFrame(() => {
      if (claim()) return;
    });
    const later = window.setTimeout(claim, 80);
    const settle = window.setTimeout(claim, 200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(later);
      window.clearTimeout(settle);
    };
  }, [visible, node.id]);

  useEffect(() => {
    const api = getJuntoApi() as JuntoTerminalApi | undefined;
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
    let lastSeq: bigint | undefined;
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

    const writeOutput = (event: TerminalOutputBatch): void => {
      const fresh: string[] = [];
      let start = 0;
      for (const chunk of event.chunks) {
        if (lastSeq === undefined || chunk.seq > lastSeq) {
          fresh.push(event.data.slice(start, chunk.end));
          lastSeq = chunk.seq;
        }
        start = chunk.end;
      }
      if (fresh.length > 0) term.write(fresh.join(""));
    };

    /**
     * A generation at `deadEpoch` ended while this surface wanted it. Follow a
     * live replacement the host already started; otherwise settle into the
     * stopped state with the host's reason.
     */
    const followOrSettle = async (deadEpoch: string | undefined): Promise<void> => {
      const live = await api
        .terminalGet?.(bindingId, hostId)
        .catch(() => undefined);
      if (!alive) return;
      const replaced =
        (live?.status === "running" || live?.status === "starting") &&
        live.epoch !== undefined &&
        live.epoch !== deadEpoch;
      if (replaced) {
        setKillPhase("idle");
        setAttachKey((key) => key + 1);
        return;
      }
      setStatus(live?.exitMessage?.trim() || "could not start");
      setKillPhase("stopped");
      setLoadPhase(null);
    };

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
      if (event.type === "output") writeOutput(event);
      if (event.type === "exit") {
        if (agentSeat && !operatorStopped.current) {
          // The host's reason, or its fail-open replacement, is one read away.
          void followOrSettle(event.epoch);
          return;
        }
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
          lastAcked.current = { ...UNKNOWN_TERMINAL_GEOMETRY };
          ptyNotifyFailCount.current = 0;
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
              if (event.type === "output") writeOutput(event);
              if (event.type === "exit") sawExit = true;
            }
            discardPending();
            // An attach that lands on an EXITED generation is a failed start
            // unless the host already replaced it. The one replacement is the
            // host's fail-open after a dead resume (local-host
            // maybeFailOpenAfterResumeFailure), which spawns on the exit stack,
            // so a single read of the binding head tells the two apart.
            // Anything else settles now with the host's reason: a seat that
            // cannot start says why on the first failure, not after retries.
            if (sawExit && agentSeat && !operatorStopped.current) {
              void followOrSettle(result.lease.epoch);
              return;
            }
            // Retained exited generations may expose their final raw journal.
            // Never paint those as a live control lease.
            setStatus(sawExit ? "exited" : "control");
            setKillPhase(sawExit ? "stopped" : "idle");
            // Correct local geometry to the real pane box BEFORE clearLoad()
            // reveals the terminal. A crew-woken seat was hydrated above at
            // the snapshot's own geometry (headless default, unless something
            // already grew it) — without this, the first frame the operator
            // ever sees is that stale size, and an alt-screen TUI (Grok) will
            // not redraw itself until its own SIGWINCH round-trip lands, so
            // the wrong-sized paint can sit visible for real time. A manual
            // open never hits this: it creates the seat at the pane's size
            // from birth, so there is nothing to attach-and-regrow. getBoundingClientRect
            // forces layout, so this measurement is accurate even though the
            // component just resumed from an async IPC round-trip; measureHost
            // safely no-ops (see pushResize) if the host is not yet laid out,
            // and the rAF/settle ladder below still covers that case.
            pushResize({ forcePaint: true });
            clearLoad();
            // Repaint through layout settle; only a real cols×rows transition is
            // forwarded to the child PTY.
            requestAnimationFrame(() => {
              if (!alive) return;
              pushResize({ forcePaint: true });
              if (!sawExit) {
                claimFocus(term.textarea ?? hostRef.current, "async", {
                  via: term,
                  owner: hostRef.current,
                });
              }
            });
            for (const ms of SETTLE_FITS_MS) {
              settleTimers.push(
                setTimeout(() => {
                  if (alive) pushResize({ forcePaint: true });
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
      const awaitLiveGeneration = async (
        startedEpoch: string | undefined,
      ): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (alive && Date.now() < deadline) {
          const live = await api.terminalGet?.(bindingId, hostId).catch(() => undefined);
          const status = live?.status;
          if (status === "running" || status === "starting") return;
          // The generation ensure started already died: attach to it now so
          // its reason shows at once instead of after the deadline.
          if (startedEpoch !== undefined && live?.epoch === startedEpoch) return;
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
          // Only the host knows whether a session exists: a pinned id on a
          // brand-new seat is a fresh start, not a resume.
          const started = startedSessionLoadPhase({
            resuming: result.resuming === true,
          });
          setLoadPhase((prev) => (prev === "stuck" ? "stuck" : started));
          setStatus(
            sessionLoadPresentation({
              phase: started,
              sessionId: pinSessionId,
            }).label,
          );
          await awaitLiveGeneration(result.epoch);
          if (!alive) return;
          runAttach();
        },
      );
    } else {
      runAttach();
    }

    return () => {
      alive = false;
      resizeGeneration.current += 1;
      notifyInFlight.current = false;
      if (ptyNotifyTimer.current !== undefined) {
        clearTimeout(ptyNotifyTimer.current);
        ptyNotifyTimer.current = undefined;
      }
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
  const harness =
    typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const gridHarness = harness !== undefined && isHarnessId(harness) ? harness : undefined;
  const surfaceId = terminalSurfaceId(node.id);
  const pinned = use$(() =>
    dock$.registry.surfaces.get().find((surface) => surface.id === surfaceId)?.zone === "pinned",
  );
  const railsOpen = use$(terminal$.railsOpenByNodeId);
  const actorRailState = actorRailsOpen(node.id, railsOpen);
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
    void getJuntoApi()
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
  const deadReason = seatDeadReason({
    reason: deadInfo.reason,
    message: deadInfo.message,
    status,
  });
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
    void getJuntoApi()
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

  return (
    <div
      ref={rootRef}
      className={[
        "native-terminal-surface",
        showDeadOverlay ? "native-terminal-surface--dead" : "",
        grid ? "native-terminal-surface--grid" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-overseer={agentSeat && isOverseerSeat(node) ? "true" : undefined}
      data-testid="native-terminal-surface"
    >
      {grid ? (
        <header
          className="native-terminal-surface__grid-header flex shrink-0 items-center gap-2 border-b border-stroke bg-raise-2 px-2"
          style={{ height: GRID_CELL_CHROME.headerPx }}
        >
          {agentSeat ? (
            <AgentPortrait identity={node.id} harness={gridHarness} size={20} />
          ) : (
            <HarnessMark agent={gridHarness} size={18} />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-ink">
            {label}
          </span>
          <span className="native-terminal-surface__status inline-flex min-w-0 shrink items-center gap-1.5 truncate text-[11px] text-dim">
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
                <span className="truncate">{status}</span>
              </>
            )}
          </span>
        </header>
      ) : (
      <OverlayHeader
        leading={agentSeat ? <AgentPortrait identity={node.id} harness={gridHarness} size={36} /> : undefined}
        eyebrow={
          agentSeat && isOverseerSeat(node) ? (
            <span className="inline-flex items-center gap-1.5">
              {terminalSurfaceEyebrow(hostId)}
              <OverseerMark size="session" />
            </span>
          ) : (
            terminalSurfaceEyebrow(hostId)
          )
        }
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
      )}
      {claimedTask && TASKS_ENABLED && !grid ? (
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
            {releasePending ? "Releasing…" : "Unassign"}
          </Button>
        </div>
      ) : null}
      {/* Body: xterm stage plus one compact right instrument pane. The ledger
          occupies the resizable top section in focus; connections fill the
          remainder. The pinned dock keeps just connections. */}
      <div className="native-terminal-surface__body">
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
                    {!grid ? (
                      <Button
                        size="sm"
                        variant="chrome"
                        title="Close view only"
                        onClick={closeSurface}
                      >
                        {deadCopy.closeViewLabel}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        {agentSeat && !grid ? (
          <aside
            className={[
              "actor-terminal-right-pane",
              pinned ? "actor-terminal-right-pane--pinned" : "",
              actorRailState.connections
                ? "actor-terminal-right-pane--connections-expanded"
                : "actor-terminal-right-pane--connections-collapsed",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label="Agent context pane"
            data-testid="actor-terminal-right-pane"
          >
            {/* Focus: one sectioned sidebar (connections included). Pinned: connections rail only. */}
            {pinned ? (
              <ActorEdgesGlance node={node} zone="pinned" />
            ) : (
              <ActorLedgerPane node={node} visible={visible} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
