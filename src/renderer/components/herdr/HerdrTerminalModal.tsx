import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  sessionRecoveryCodeFromReason,
  sessionRecoveryShouldAutoReconnect,
  type SessionRecoveryCode,
} from "@shared/terminal-session-domain";
import {
  canAutoReconnect,
  closeHerdrTerminal,
  focusHerdrTerminal,
  herdr$,
  setConnectionEvent,
  setTerminalStreamId,
} from "../../lib/herdr-state";
import { recreateHerdrPane } from "../../lib/herdr-actions";
import { extractHerdrClipboardImage } from "../../lib/herdr-clipboard-image";
import { dock$, herdrSurfaceId } from "../../lib/dock-state";
import { MONO_CELL } from "../../lib/focus-measure";
import { getVellumCommandApi } from "../../lib/vellum-api";
import {
  VELLUM_XTERM_FONT_FAMILY,
  VELLUM_XTERM_FONT_SIZE,
  xtermThemeFor,
} from "../../lib/terminal-theme";
import { attachXtermAppearance } from "../../lib/xterm-appearance";
import { themeMode$ } from "../../lib/theme-mode";
import { attachXtermAutoCopy } from "../../lib/xterm-auto-copy";
import { ActivityMark } from "../ActivityMark";
import { FocusSurface } from "../FocusSurface";
import { Button, OverlayHeader } from "../ui";

/** Fallback cell when xterm has not measured fonts yet (13×0.6 / 13×1.2). */
const FALLBACK_CELL_W = MONO_CELL.fontSizePx * MONO_CELL.ratio;
const FALLBACK_CELL_H = MONO_CELL.fontSizePx * 1.2;
/** Must match CSS padding on `.herdr-xterm .xterm` (6+6 / 8+8). */
const XTERM_PAD_X = 16;
const XTERM_PAD_Y = 12;
const RESIZE_DEBOUNCE_MS = 48;
/** After open/attach, wait for focus-shell enter + stored size apply. */
const SETTLE_FITS_MS = [0, 50, 160, 320, 600] as const;
/** One ±1-row PTY nudge after settle so TUIs redraw on pin/dock remount. */
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
 * default 80×24 canvas, FitAddon freezes on that island forever.
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

const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const base64ToUtf8 = (b64: string): string => {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
};

/** Browser key → PTY bytes. Escape goes to the PTY (TUIs need it); close is ⌘W / Close / backdrop. */
const keyEventToPty = (e: KeyboardEvent): string | null => {
  if (e.isComposing) return null;
  if (e.metaKey || e.altKey) return null;

  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }

  switch (e.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    case "Escape":
      return "\x1b";
    default:
      break;
  }

  if (e.key.length === 1 && !e.ctrlKey) return e.key;
  return null;
};

import type { HerdrRetainedPayload } from "@shared/ipc";

type HerdrApi = NonNullable<ReturnType<typeof getVellumCommandApi>> & {
  herdrStreamOpen: (input: {
    hostId: string;
    session?: string | null;
    terminalId: string;
    cols: number;
    rows: number;
    takeover?: boolean;
  }) => Promise<{ ok: boolean; streamId?: string; message?: string; retained?: HerdrRetainedPayload | ReadonlyArray<string> }>;
  herdrObserveRetained?: (terminalId: string) => Promise<HerdrRetainedPayload | ReadonlyArray<string>>;
  herdrStreamInput: (streamId: string, data: string) => Promise<{ ok?: boolean; error?: string }>;
  herdrStreamPasteImage: (
    streamId: string,
    extension: string,
    dataBase64: string,
  ) => Promise<{ ok?: boolean; error?: string; path?: string }>;
  herdrStreamResize: (streamId: string, cols: number, rows: number) => Promise<unknown>;
  herdrStreamScroll: (
    streamId: string,
    delta: number,
    at?: { column: number; row: number; modifiers: number },
  ) => Promise<unknown>;
  herdrStreamClose: (streamId: string) => Promise<unknown>;
  herdrEnsureServer: (hostId: string, session?: string | null) => Promise<{ ok: boolean; message?: string }>;
  herdrGetMeta: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<{ ok: boolean; data?: { terminalId?: string }; message?: string }>;
  onHerdrStreamEvent: (
    listener: (event: {
      streamId: string;
      type: "frame" | "closed" | "error";
      bytes?: string;
      full?: boolean;
      reason?: string;
      message?: string;
      /** SessionRecoveryCode for reconnect policy. */
      code?: string;
    }) => void,
  ) => () => void;
};

/**
 * Herdr terminal work surface for one nodeId: header + xterm + stream lifecycle.
 * xterm is display-only; keyboard is window-level capture ONLY while this
 * nodeId === focusedNodeId (click the panel to focus). Multiple panels may
 * mount; only the focused one steals keys.
 */
export function HerdrTerminalPanel({
  variant,
  nodeId,
}: {
  readonly variant: "modal" | "dock";
  readonly nodeId: string;
}) {
  const terminalOpen = use$(herdr$.terminals[nodeId]);
  const focusedNodeId = use$(herdr$.focusedNodeId);
  const isFocused = focusedNodeId === nodeId;
  const conn = use$(herdr$.connectionByNodeId[nodeId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef<string | undefined>(undefined);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const apiRef = useRef<HerdrApi | undefined>(undefined);
  // Host/session/terminalId may churn without a pane change; effect keys only
  // on paneId and reads live binding via this ref (avoids full reconnect).
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;
  const [status, setStatus] = useState("connecting…");
  const [geom, setGeom] = useState({ cols: 0, rows: 0 });
  const paneId = terminalOpen?.herdr.paneId;

  // Keyboard: window capture only while this panel is the focused herdr.
  useEffect(() => {
    if (!terminalOpen || !isFocused) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Close on ⌘W/Ctrl+W only — Escape belongs to the terminal (agent TUIs
      // use it to interrupt); Close button and backdrop remain pointer exits.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeHerdrTerminal(nodeId);
        return;
      }

      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-herdr-chrome]")) return;

      // Steal from canvas / app shortcuts while this terminal is focused.
      e.stopPropagation();

      if (e.metaKey || e.altKey) return;

      const pty = keyEventToPty(e);
      if (pty == null) return;

      e.preventDefault();
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api) {
        setStatus("input dropped - stream not ready");
        return;
      }
      void api.herdrStreamInput(id, utf8ToBase64(pty)).then((res) => {
        if (res && res.ok === false && res.error) setStatus(`input failed: ${res.error}`);
      });
    };

    const sendClipboardImage = (
      image: { readonly extension: string; readonly dataBase64: string; readonly byteLength: number },
    ) => {
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api?.herdrStreamPasteImage) {
        setStatus("image paste dropped - stream not ready");
        return;
      }
      setStatus(`pasting image (${image.byteLength} B)…`);
      void api
        .herdrStreamPasteImage(id, image.extension, image.dataBase64)
        .then((res) => {
          if (res && res.ok === false && res.error) {
            setStatus(`image paste failed: ${res.error}`);
            return;
          }
          const path = typeof res?.path === "string" ? res.path : "";
          setStatus(
            path
              ? `image path pasted - ${path}`
              : `image path pasted - ${image.extension} - ${image.byteLength} B`,
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(`image paste failed: ${msg}`);
        });
    };

    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-herdr-chrome]")) return;
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api) return;

      // Image first (screenshot / copied file). Text paste remains the fallback.
      // Capture text *before* any await — clipboard DataTransfer text often clears after.
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text") ?? "";
      const data = e.clipboardData;
      void (async () => {
        const image = await extractHerdrClipboardImage(data);
        if (image && "error" in image) {
          setStatus(`image paste failed: ${image.error}`);
          return;
        }
        if (image) {
          sendClipboardImage(image);
          return;
        }
        if (!text) return;
        void api.herdrStreamInput(id, utf8ToBase64(text)).then((res) => {
          if (res && res.ok === false && res.error) setStatus(`input failed: ${res.error}`);
        });
      })();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, [Boolean(terminalOpen), isFocused, nodeId]);

  // Stream + xterm lifecycle — keyed on paneId only. Host/session/terminalId
  // are read from terminalOpenRef so binding churn does not full-reconnect.
  useEffect(() => {
    if (!paneId || !hostRef.current) return;
    if (!terminalOpenRef.current) return;
    const api = getVellumCommandApi() as HerdrApi | undefined;
    apiRef.current = api;
    const hostEl = hostRef.current;
    if (!api?.herdrStreamOpen || !api.onHerdrStreamEvent) {
      setStatus("herdr stream API unavailable");
      return;
    }

    const term = new Terminal({
      disableStdin: true, // display only — keyboard is window-level
      cursorBlink: true,
      fontSize: VELLUM_XTERM_FONT_SIZE,
      fontFamily: VELLUM_XTERM_FONT_FAMILY,
      lineHeight: 1.2,
      theme: xtermThemeFor(themeMode$.peek()),
      allowProposedApi: true,
      scrollback: 0,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    hostEl.replaceChildren();
    term.open(hostEl);
    // xterm is display-only, but with scrollback: 0 its screen-element wheel
    // listener consumes wheel events itself (alt-buffer arrow synthesis) and
    // cancels them before they bubble to hostEl. Returning false here makes
    // xterm ignore wheel entirely; the modal owns all pointer input.
    term.attachCustomWheelEventHandler(() => false);
    termRef.current = term;
    fitRef.current = fit;

    // Live appearance: full Vellum Command palette + CSI ?996n/?2031/?997 protocol.
    const appearance = attachXtermAppearance(term, {
      initialMode: themeMode$.peek(),
      policy: "follow",
    });
    const unsubTheme = themeMode$.onChange(({ value }) => {
      appearance.setMode(value);
    });

    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObs: ResizeObserver | undefined;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];

    // Retained-frame placeholder (VL-020): paint the observe pool's last known
    // pixels immediately, dimmed; the control stream's first full frame resets
    // the terminal and swaps to live at full opacity.
    let liveFrameSeen = false;
    let placeholderPainted = false;
    const writePlaceholder = (payload: HerdrRetainedPayload | ReadonlyArray<string> | undefined): void => {
      if (!payload || cancelled || liveFrameSeen || placeholderPainted) return;
      const isObj = typeof payload === "object" && "frames" in payload;
      const frames = isObj ? payload.frames : payload;
      if (!frames?.length) return;
      placeholderPainted = true;
      if (isObj && payload.cols && payload.rows && payload.cols >= 20 && payload.rows >= 5) {
        try {
          term.resize(payload.cols, payload.rows);
        } catch {
          // ignore
        }
      }
      hostEl.style.transition = "opacity 160ms ease";
      hostEl.style.opacity = "0.55";
      for (const bytes of frames) term.write(base64ToUtf8(bytes));
    };
    const markLive = (): void => {
      if (!liveFrameSeen) {
        liveFrameSeen = true;
        // First live frame after open/reconnect resets attempt counters.
        setConnectionEvent(nodeId, { type: "ok" });
      }
      hostEl.style.opacity = "1";
    };
    // Cached terminal id is good enough for a dimmed preview — the live id is
    // re-resolved in openStream; a stale preview is wiped by the first full frame.
    const seedTerminalId = terminalOpenRef.current?.herdr.terminalId;
    if (seedTerminalId && api.herdrObserveRetained) {
      void api
        .herdrObserveRetained(seedTerminalId)
        .then(writePlaceholder)
        .catch(() => undefined);
    }

    /**
     * Host-box geometry is authority once getBoundingClientRect is real.
     * Do not max with FitAddon — that blocked focus→pin shrink. Island
     * defense is CSS (flex:1;height:0). Returns null while the flex host
     * has not yet been assigned a real box.
     */
    const measure = (): { cols: number; rows: number } | null => {
      const measured = measureHost(hostEl, term);
      if (!measured) return null;

      const cols = Math.max(20, Math.min(300, measured.cols));
      const rows = Math.max(5, Math.min(120, measured.rows));

      if (term.cols !== cols || term.rows !== rows) {
        try {
          term.resize(cols, rows);
        } catch {
          return null;
        }
      }

      setGeom((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
      return { cols, rows };
    };

    const pushResize = () => {
      const geomNow = measure();
      if (!geomNow) return;
      const id = streamIdRef.current;
      if (!id) return;
      void api.herdrStreamResize(id, geomNow.cols, geomNow.rows);
    };

    /** Temporary ±1 row then restore — forces TUI redraw after pin settle. */
    const forcePtyNudge = (): void => {
      const id = streamIdRef.current;
      if (!id || cancelled) return;
      const measured = measureHost(hostEl, term);
      if (!measured) return;
      const cols = Math.max(20, Math.min(300, measured.cols));
      const rows = Math.max(5, Math.min(120, measured.rows));
      const nudgedRows = Math.max(5, rows - 1);
      try {
        term.resize(cols, nudgedRows);
      } catch {
        return;
      }
      void api.herdrStreamResize(id, cols, nudgedRows);
      requestAnimationFrame(() => {
        if (cancelled || streamIdRef.current !== id) return;
        try {
          term.resize(cols, rows);
        } catch {
          return;
        }
        void api.herdrStreamResize(id, cols, rows);
        setGeom({ cols, rows });
      });
    };

    const hardFitBurst = (): void => {
      for (const ms of SETTLE_FITS_MS) {
        settleTimers.push(setTimeout(() => {
          if (!cancelled) pushResize();
        }, ms));
      }
      settleTimers.push(
        setTimeout(() => {
          if (!cancelled) forcePtyNudge();
        }, PTY_NUDGE_AFTER_SETTLE_MS),
      );
    };

    const openStream = async () => {
      setStatus("ensuring server…");
      const open = terminalOpenRef.current;
      if (!open) return;
      const herdr = open.herdr;
      const ensure = await api.herdrEnsureServer(herdr.host, herdr.session ?? null);
      if (cancelled) return;
      if (!ensure.ok) {
        setStatus(ensure.message ?? "ensure failed");
        setConnectionEvent(open.nodeId, { type: "host_unreachable" });
        return;
      }

      // Terminal ids regenerate whenever the herdr server restarts or live-
      // hands-off; a cached id then fails every reconnect and the modal spins
      // in an attach loop. The pane id is the stable handle — always re-resolve
      // the live terminal id from it, falling back to the cached one.
      // Re-read ref after await: host/session may have updated mid-flight.
      const live = terminalOpenRef.current;
      if (!live) return;
      const liveHerdr = live.herdr;
      let terminalId: string | undefined;
      if (liveHerdr.paneId) {
        const meta = await api.herdrGetMeta(liveHerdr.host, liveHerdr.session ?? null, liveHerdr.paneId);
        if (cancelled) return;
        terminalId = meta.data?.terminalId;
      }
      terminalId ||= terminalOpenRef.current?.herdr.terminalId ?? liveHerdr.terminalId;
      if (!terminalId) {
        setStatus("no terminal id on bound pane");
        setConnectionEvent(live.nodeId, { type: "pane_missing" });
        return;
      }

      // Wait two frames so flex layout has real size before we measure.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (cancelled) return;
      // Fallback dims only if host is still collapsing (should be rare after island CSS).
      const measured = measure() ?? { cols: 80, rows: 24 };
      const { cols, rows } = measured;

      const attachHerdr = terminalOpenRef.current?.herdr ?? liveHerdr;
      setStatus(`attaching ${cols}×${rows}…`);
      const opened = await api.herdrStreamOpen({
        hostId: attachHerdr.host,
        session: attachHerdr.session ?? null,
        terminalId,
        cols,
        rows,
        takeover: true,
      });
      // Cancel-after-open must detach control — otherwise main keeps a global
      // takeover stream with no UI owner (VL-030).
      if (cancelled) {
        if (opened.ok && opened.streamId) {
          void api.herdrStreamClose?.(opened.streamId).catch(() => undefined);
        }
        return;
      }
      if (!opened.ok || !opened.streamId) {
        setStatus(opened.message ?? "stream open failed");
        setConnectionEvent(nodeId, { type: "stream_drop" });
        return;
      }
      // Pool handoff: frames captured before the observe stream was paused.
      writePlaceholder(opened.retained);
      streamIdRef.current = opened.streamId;
      setTerminalStreamId(nodeId, opened.streamId);
      setStatus("connected");
      setConnectionEvent(nodeId, { type: "ok" });
      // Settle burst after attach — focus enter + stored focusSize often lag first paint.
      hardFitBurst();
    };

    const unsub = api.onHerdrStreamEvent((event) => {
      if (event.streamId !== streamIdRef.current) return;
      if (event.type === "frame" && event.bytes) {
        const text = base64ToUtf8(event.bytes);
        if (!liveFrameSeen && placeholderPainted) term.reset(); // wipe placeholder
        markLive();
        if (event.full) term.reset();
        term.write(text);
      } else if (event.type === "error") {
        setStatus(event.message ?? "stream error");
      } else if (event.type === "closed") {
        // Domain recovery codes drive reconnect — intentional detach must not thrash.
        const code: SessionRecoveryCode =
          (event.code as SessionRecoveryCode | undefined) ??
          sessionRecoveryCodeFromReason(event.reason);
        streamIdRef.current = undefined;
        setTerminalStreamId(nodeId, undefined);
        // stream_drop first so canAutoReconnect sees degraded state.
        setConnectionEvent(nodeId, { type: "stream_drop" });
        if (sessionRecoveryShouldAutoReconnect(code) && canAutoReconnect(nodeId)) {
          setConnectionEvent(nodeId, { type: "reconnect_start" });
          setStatus("reconnecting…");
          void openStream();
        } else if (code === "pane_gone") {
          setStatus("pane closed");
          setConnectionEvent(nodeId, { type: "pane_closed" });
        } else if (!sessionRecoveryShouldAutoReconnect(code)) {
          // client_close / renderer_reloaded / supersede — stay quiet.
          setStatus(code === "client_close" ? "detached" : `closed - ${code}`);
        } else {
          setStatus(`closed - ${code}`);
          setConnectionEvent(nodeId, { type: "reconnect_exhausted" });
        }
      }
    });

    const scheduleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushResize();
      }, RESIZE_DEBOUNCE_MS);
    };
    /** Detect unpark / pin reflow so wheel hit-test geometry re-syncs. */
    let lastHostBox = { w: 0, h: 0 };
    let prevHostTiny = true;
    window.addEventListener("resize", scheduleResize);
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver((entries) => {
        const entry = entries[0];
        const w = entry?.contentRect.width ?? hostEl.getBoundingClientRect().width;
        const h = entry?.contentRect.height ?? hostEl.getBoundingClientRect().height;
        const nowReal = w >= 40 && h >= 40;
        const nowTiny = !nowReal;
        const grewBack = prevHostTiny && nowReal;
        const sizeJump =
          lastHostBox.w > 0 &&
          nowReal &&
          (Math.abs(w - lastHostBox.w) > 24 || Math.abs(h - lastHostBox.h) > 24);
        prevHostTiny = nowTiny;
        if (nowReal) lastHostBox = { w, h };
        // Reuse stream hardFitBurst (settle + PTY nudge) on unpark / pin reflow.
        if (grewBack || sizeJump) {
          hardFitBurst();
          scheduleResize();
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
          } catch {
            // ignore
          }
          return;
        }
        scheduleResize();
      });
      resizeObs.observe(hostEl);
      // Focus panel + workbench panes reflow on pin/split/stored focusSize.
      const panelRoot = hostEl.closest(".herdr-terminal-panel");
      const ancestors = [
        panelRoot,
        hostEl.closest(".herdr-modal-panel"),
        hostEl.closest(".focus-surface__panel"),
        hostEl.closest(".workbench-pane"),
        hostEl.closest(".workbench-panes"),
        hostEl.closest(".work-focus-shell"),
        hostEl.closest(".work-surface-dock"),
        hostEl.closest(".dock-slot"),
      ];
      for (const el of ancestors) {
        if (el instanceof Element) resizeObs.observe(el);
      }
    }

    // Local geom paint before stream attach (status 0×0 → real box).
    requestAnimationFrame(() => {
      if (!cancelled) measure();
    });

    // Cell under the pointer. herdr routes wheel to mouse-reporting apps as an
    // SGR event at this cell; falling back to the screen center beats herdr's
    // (0,0) corner default when geometry is not measurable yet.
    const cellAt = (e: MouseEvent): { column: number; row: number } => {
      const cols = Math.max(1, term.cols | 0);
      const rows = Math.max(1, term.rows | 0);
      const rect = hostEl.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) {
        return { column: cols >> 1, row: rows >> 1 };
      }
      const column = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * cols)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * rows)));
      return { column, row };
    };

    // crossterm KeyModifiers bits: SHIFT=1, CONTROL=2, ALT=4.
    const modifierBits = (e: MouseEvent): number =>
      (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);

    // Coalesce wheel ticks: over ssh, one NDJSON command per trackpad tick
    // floods the stream and the frame echo queues up (rubber-banding). First
    // tick flushes immediately; the rest accumulate into one command per 50ms
    // window. herdr fans `lines` back out into per-tick wheel reports.
    let wheelDelta = 0;
    let wheelLast: WheelEvent | null = null;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;

    const flushWheel = () => {
      const id = streamIdRef.current;
      const e = wheelLast;
      const delta = wheelDelta;
      wheelDelta = 0;
      wheelLast = null;
      if (!id || !e || delta === 0) return;
      const lines = Math.max(1, Math.min(20, Math.round(Math.abs(delta) / 40) || 1));
      const { column, row } = cellAt(e);
      void api.herdrStreamScroll(id, delta < 0 ? -lines : lines, {
        column,
        row,
        modifiers: modifierBits(e),
      });
    };

    const onWheel = (e: WheelEvent) => {
      if (!streamIdRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      // Direction reversal flushes immediately so it never feels laggy.
      if (wheelDelta !== 0 && Math.sign(e.deltaY) !== Math.sign(wheelDelta)) flushWheel();
      wheelDelta += e.deltaY;
      wheelLast = e;
      if (wheelTimer) return;
      flushWheel();
      wheelTimer = setTimeout(() => {
        wheelTimer = null;
        flushWheel();
      }, 50);
    };
    // Capture phase: run before xterm's own listeners on descendant elements.
    hostEl.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // NOTE: no pointer (hover/click/drag) forwarding — stock herdr's control
    // protocol has no mouse command. Wheel is the only pointer input it accepts.

    // Image file drop — same stage+path path as clipboard paste.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      const id = streamIdRef.current;
      if (!id || !api.herdrStreamPasteImage) {
        setStatus("image drop dropped - stream not ready");
        return;
      }
      void (async () => {
        const image = await extractHerdrClipboardImage(e.dataTransfer);
        if (image && "error" in image) {
          setStatus(`image drop failed: ${image.error}`);
          return;
        }
        if (!image) {
          setStatus("drop ignored - not an image");
          return;
        }
        setStatus(`pasting image (${image.byteLength} B)…`);
        try {
          const res = await api.herdrStreamPasteImage(id, image.extension, image.dataBase64);
          if (res && res.ok === false && res.error) {
            setStatus(`image drop failed: ${res.error}`);
            return;
          }
          const path = typeof res?.path === "string" ? res.path : "";
          setStatus(
            path
              ? `image path pasted - ${path}`
              : `image path pasted - ${image.extension} - ${image.byteLength} B`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(`image drop failed: ${msg}`);
        }
      })();
    };

    hostEl.addEventListener("dragover", onDragOver);
    hostEl.addEventListener("drop", onDrop);

    // Drag-select → system clipboard on mouseup (shared with native PTY).
    const detachAutoCopy = attachXtermAutoCopy(hostEl, term);

    void openStream();

    return () => {
      cancelled = true;
      detachAutoCopy();
      unsub();
      unsubTheme();
      appearance.dispose();
      window.removeEventListener("resize", scheduleResize);
      resizeObs?.disconnect();
      hostEl.removeEventListener("wheel", onWheel, { capture: true });
      hostEl.removeEventListener("dragover", onDragOver);
      hostEl.removeEventListener("drop", onDrop);
      if (wheelTimer) clearTimeout(wheelTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const t of settleTimers) clearTimeout(t);
      const id = streamIdRef.current;
      if (id) void api.herdrStreamClose(id);
      streamIdRef.current = undefined;
      apiRef.current = undefined;
      term.dispose();
      termRef.current = null;
    };
  }, [nodeId, paneId]);

  // Force a layout pass when opening so host has non-zero size.
  useLayoutEffect(() => {
    if (!terminalOpen) return;
    const el = hostRef.current;
    if (!el) return;
    // Touch layout
    void el.offsetHeight;
  }, [Boolean(terminalOpen)]);

  if (!terminalOpen) return null;

  const claimFocus = () => {
    focusHerdrTerminal(nodeId);
  };

  // Status line: ActivityMark carries connected/connecting; the text adds
  // identity + geometry + stream status. conn.state joins only when it adds
  // information (never a bare "connected - connected" repeat).
  const connState = conn?.state;
  const statusBits = [
    terminalOpen.herdr.host,
    terminalOpen.herdr.paneId || undefined,
    geom.cols ? `${geom.cols}×${geom.rows}` : undefined,
    status !== connState ? status : undefined,
    connState && connState !== "connected" ? connState : undefined,
  ].filter((bit): bit is string => Boolean(bit));

  const chrome = (
    <div
      className={isFocused ? "herdr-terminal-panel herdr-terminal-panel--focused" : "herdr-terminal-panel"}
      data-herdr-node={nodeId}
      data-herdr-focused={isFocused ? "1" : "0"}
      onMouseDown={claimFocus}
    >
      <OverlayHeader
        data-herdr-chrome
        eyebrow={`herdr${isFocused ? " — focused" : ""}`}
        title={terminalOpen.title}
        status={
          <span className="herdr-modal-status inline-flex items-center gap-1.5">
            <ActivityMark
              mode={connState === "connected" ? "static" : "wave"}
              tone="amber"
              size="inline"
              label={connState === "connected" ? "connected" : "connecting"}
            />
            {statusBits.join(" - ")}
          </span>
        }
        actions={
          <>
            {(connState === "failed" || connState === "lost" || connState === "degraded") && (
              <Button
                size="xs"
                variant="chrome"
                data-herdr-chrome
                onClick={() => void recreateHerdrPane(terminalOpen.nodeId, terminalOpen.herdr)}
              >
                recreate
              </Button>
            )}
            <Button
              size="xs"
              variant="primary"
              data-herdr-chrome
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeHerdrTerminal(nodeId);
              }}
            >
              Close
            </Button>
          </>
        }
      />

      <div ref={hostRef} className="herdr-xterm herdr-modal-body" />
    </div>
  );

  // Dock: fill the work-surface slot (no focus measure — slot owns width).
  if (variant === "dock") {
    return <div className="herdr-modal-panel herdr-dock-panel">{chrome}</div>;
  }

  // Focus surface: measure-constrained centered terminal (see focus-measure.ts).
  // Esc is owned by the PTY — close via Close / ⌘W / backdrop only.
  return (
    <FocusSurface
      measure="terminal"
      height="immersive"
      layer="work"
      label="Herdr terminal"
      onClose={() => closeHerdrTerminal(nodeId)}
      closeOnEscape={false}
      closeOnBackdrop
    >
      {chrome}
    </FocusSurface>
  );
}

/**
 * Full-window herdr surfaces for open terminals not yet hosted by the workbench
 * registry (fallback). WorkSurfaceDock owns surfaces once synced.
 */
export function HerdrTerminalModal() {
  const terminals = use$(herdr$.terminals);
  const registry = use$(dock$.registry);
  const hosted = new Set(
    registry.surfaces.filter((s) => s.kind === "herdr").map((s) => s.id),
  );
  const orphanIds = Object.keys(terminals).filter((id) => !hosted.has(herdrSurfaceId(id)));
  if (orphanIds.length === 0) return null;
  return (
    <>
      {orphanIds.map((id) => (
        <HerdrTerminalPanel key={id} variant="modal" nodeId={id} />
      ))}
    </>
  );
}
