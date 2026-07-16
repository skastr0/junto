import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  canAutoReconnect,
  closeHerdrTerminal,
  herdr$,
  setConnectionEvent,
  setTerminalStreamId,
} from "../../lib/herdr-state";
import { recreateHerdrPane } from "../../lib/herdr-actions";
import { dock$ } from "../../lib/dock-state";
import { getVellumApi } from "../../lib/vellum-api";
import { HUE } from "../../lib/theme";

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

/** Browser key → PTY bytes. Escape is reserved for modal close (not sent). */
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
      return null; // modal close only
    default:
      break;
  }

  if (e.key.length === 1 && !e.ctrlKey) return e.key;
  return null;
};

type HerdrApi = NonNullable<ReturnType<typeof getVellumApi>> & {
  herdrStreamOpen: (input: {
    hostId: string;
    session?: string | null;
    terminalId: string;
    cols: number;
    rows: number;
    takeover?: boolean;
  }) => Promise<{ ok: boolean; streamId?: string; message?: string }>;
  herdrStreamInput: (streamId: string, data: string) => Promise<{ ok?: boolean; error?: string }>;
  herdrStreamResize: (streamId: string, cols: number, rows: number) => Promise<unknown>;
  herdrStreamScroll: (
    streamId: string,
    delta: number,
    at?: { column: number; row: number; modifiers: number },
  ) => Promise<unknown>;
  herdrStreamMouse: (
    streamId: string,
    input: {
      kind: "down" | "up" | "drag" | "moved";
      button?: "left" | "right" | "middle";
      column: number;
      row: number;
      modifiers: number;
    },
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
    }) => void,
  ) => () => void;
};

/**
 * Herdr terminal work surface: header + xterm + stream lifecycle. xterm is
 * display-only; keyboard is owned by a window-level capture handler so focus
 * never blocks typing. Two hosts render it (never both at once — the dock's
 * herdr slot suppresses the modal): full-window HerdrTerminalModal below, and
 * WorkSurfaceDock's interactive slot ("dock" variant, inline, no portal or
 * backdrop). Either way herdr$.terminal stays the single source, so there is
 * exactly one control stream total.
 */
export function HerdrTerminalPanel({ variant }: { readonly variant: "modal" | "dock" }) {
  const terminalOpen = use$(herdr$.terminal);
  const nodeId = terminalOpen?.nodeId ?? "";
  const conn = use$(herdr$.connectionByNodeId[nodeId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef<string | undefined>(undefined);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const apiRef = useRef<HerdrApi | undefined>(undefined);
  const [status, setStatus] = useState("connecting…");
  const [geom, setGeom] = useState({ cols: 0, rows: 0 });

  // Keyboard: window capture while open — independent of focus/xterm.
  useEffect(() => {
    if (!terminalOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Always allow Esc to dismiss.
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeHerdrTerminal();
        return;
      }

      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-herdr-chrome]")) return;

      // Steal from canvas / app shortcuts while modal is open.
      e.stopPropagation();

      if (e.metaKey || e.altKey) return;

      const pty = keyEventToPty(e);
      if (pty == null) return;

      e.preventDefault();
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api) {
        setStatus("input dropped · stream not ready");
        return;
      }
      void api.herdrStreamInput(id, utf8ToBase64(pty)).then((res) => {
        if (res && res.ok === false && res.error) setStatus(`input failed: ${res.error}`);
      });
    };

    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-herdr-chrome]")) return;
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api) return;
      void api.herdrStreamInput(id, utf8ToBase64(text));
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, [Boolean(terminalOpen)]);

  // Stream + xterm lifecycle
  useEffect(() => {
    if (!terminalOpen || !hostRef.current) return;
    const api = getVellumApi() as HerdrApi | undefined;
    apiRef.current = api;
    const hostEl = hostRef.current;
    if (!api?.herdrStreamOpen || !api.onHerdrStreamEvent) {
      setStatus("herdr stream API unavailable");
      return;
    }

    const term = new Terminal({
      disableStdin: true, // display only — keyboard is window-level
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      theme: {
        background: "#0c0b0a",
        foreground: "#EDE6DA",
        cursor: "#E8A33D",
      },
      allowProposedApi: true,
      scrollback: 0,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    hostEl.replaceChildren();
    term.open(hostEl);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObs: ResizeObserver | undefined;

    const measure = (): { cols: number; rows: number } => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
      // Prefer measured xterm geometry; fall back to pixel estimate.
      let cols = term.cols | 0;
      let rows = term.rows | 0;
      if (cols < 20 || rows < 5) {
        const w = hostEl.clientWidth || 800;
        const h = hostEl.clientHeight || 480;
        // 13px mono ≈ 7.8×16 cell
        cols = Math.max(20, Math.floor(w / 7.8));
        rows = Math.max(5, Math.floor(h / 16));
      }
      cols = Math.max(20, Math.min(300, cols));
      rows = Math.max(5, Math.min(120, rows));
      setGeom({ cols, rows });
      return { cols, rows };
    };

    const pushResize = () => {
      const id = streamIdRef.current;
      if (!id) return;
      const { cols, rows } = measure();
      void api.herdrStreamResize(id, cols, rows);
    };

    const openStream = async () => {
      setStatus("ensuring server…");
      const herdr = terminalOpen.herdr;
      const ensure = await api.herdrEnsureServer(herdr.host, herdr.session ?? null);
      if (cancelled) return;
      if (!ensure.ok) {
        setStatus(ensure.message ?? "ensure failed");
        setConnectionEvent(terminalOpen.nodeId, { type: "host_unreachable" });
        return;
      }

      let terminalId = herdr.terminalId;
      if (!terminalId && herdr.paneId) {
        const meta = await api.herdrGetMeta(herdr.host, herdr.session ?? null, herdr.paneId);
        if (cancelled) return;
        terminalId = meta.data?.terminalId;
      }
      if (!terminalId) {
        setStatus("no terminal id on bound pane");
        setConnectionEvent(terminalOpen.nodeId, { type: "pane_missing" });
        return;
      }

      // Wait two frames so flex layout has real size before we measure.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (cancelled) return;
      const { cols, rows } = measure();

      setStatus(`attaching ${cols}×${rows}…`);
      const opened = await api.herdrStreamOpen({
        hostId: herdr.host,
        session: herdr.session ?? null,
        terminalId,
        cols,
        rows,
        takeover: true,
      });
      if (cancelled) return;
      if (!opened.ok || !opened.streamId) {
        setStatus(opened.message ?? "stream open failed");
        setConnectionEvent(terminalOpen.nodeId, { type: "stream_drop" });
        return;
      }
      streamIdRef.current = opened.streamId;
      setTerminalStreamId(opened.streamId);
      setStatus(`connected · ${cols}×${rows} · type · Esc closes`);
      setConnectionEvent(terminalOpen.nodeId, { type: "ok" });
      // One more resize after attach — layout often settles after first paint.
      window.setTimeout(() => {
        if (!cancelled) pushResize();
      }, 100);
    };

    const unsub = api.onHerdrStreamEvent((event) => {
      if (event.streamId !== streamIdRef.current) return;
      if (event.type === "frame" && event.bytes) {
        const text = base64ToUtf8(event.bytes);
        if (event.full) term.reset();
        term.write(text);
      } else if (event.type === "error") {
        setStatus(event.message ?? "stream error");
      } else if (event.type === "closed") {
        setStatus(`closed · ${event.reason ?? "eof"}`);
        setConnectionEvent(terminalOpen.nodeId, { type: "stream_drop" });
        streamIdRef.current = undefined;
        setTerminalStreamId(undefined);
        if (canAutoReconnect(terminalOpen.nodeId)) {
          setConnectionEvent(terminalOpen.nodeId, { type: "reconnect_start" });
          setStatus("reconnecting…");
          void openStream();
        } else {
          setConnectionEvent(terminalOpen.nodeId, { type: "reconnect_exhausted" });
        }
      }
    });

    const scheduleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(pushResize, 60);
    };
    window.addEventListener("resize", scheduleResize);
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => scheduleResize());
      resizeObs.observe(hostEl);
    }

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

    const onWheel = (e: WheelEvent) => {
      const id = streamIdRef.current;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const lines = Math.max(1, Math.min(12, Math.round(Math.abs(e.deltaY) / 40) || 1));
      const { column, row } = cellAt(e);
      void api.herdrStreamScroll(id, e.deltaY < 0 ? -lines : lines, {
        column,
        row,
        modifiers: modifierBits(e),
      });
    };
    hostEl.addEventListener("wheel", onWheel, { passive: false });

    // Mouse forwarding: hover/click/drag → terminal.mouse. herdr's emulation
    // encodes for the child app only when it enabled mouse reporting (grok-style
    // TUIs), so forwarding is inert on plain shells. Motion is cell-deduped.
    type MouseButtonName = "left" | "right" | "middle";
    let dragButton: MouseButtonName | null = null;
    let lastMotionCell = { column: -1, row: -1 };

    const buttonName = (button: number): MouseButtonName | null =>
      button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;

    const sendMouse = (
      kind: "down" | "up" | "drag" | "moved",
      button: MouseButtonName | null,
      cell: { column: number; row: number },
      e: MouseEvent,
    ) => {
      const id = streamIdRef.current;
      if (!id) return;
      void api.herdrStreamMouse(id, {
        kind,
        ...(button ? { button } : {}),
        column: cell.column,
        row: cell.row,
        modifiers: modifierBits(e),
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      const btn = buttonName(e.button);
      if (!btn) return;
      e.preventDefault();
      dragButton = btn;
      sendMouse("down", btn, cellAt(e), e);
    };
    const onMouseUp = (e: MouseEvent) => {
      const btn = buttonName(e.button) ?? dragButton;
      const wasDragging = dragButton != null;
      dragButton = null;
      if (!btn || !wasDragging) return;
      sendMouse("up", btn, cellAt(e), e);
    };
    const onMouseMove = (e: MouseEvent) => {
      const cell = cellAt(e);
      if (cell.column === lastMotionCell.column && cell.row === lastMotionCell.row) return;
      lastMotionCell = cell;
      if (dragButton) sendMouse("drag", dragButton, cell, e);
      else sendMouse("moved", null, cell, e);
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    hostEl.addEventListener("mousedown", onMouseDown);
    hostEl.addEventListener("mousemove", onMouseMove);
    hostEl.addEventListener("contextmenu", onContextMenu);
    // Releases outside the terminal must still end the drag.
    window.addEventListener("mouseup", onMouseUp);

    void openStream();

    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener("resize", scheduleResize);
      resizeObs?.disconnect();
      hostEl.removeEventListener("wheel", onWheel);
      if (resizeTimer) clearTimeout(resizeTimer);
      const id = streamIdRef.current;
      if (id) void api.herdrStreamClose(id);
      streamIdRef.current = undefined;
      apiRef.current = undefined;
      term.dispose();
      termRef.current = null;
    };
  }, [terminalOpen?.nodeId, terminalOpen?.herdr.paneId, terminalOpen?.herdr.terminalId]);

  // Force a layout pass when opening so host has non-zero size.
  useLayoutEffect(() => {
    if (!terminalOpen) return;
    const el = hostRef.current;
    if (!el) return;
    // Touch layout
    void el.offsetHeight;
  }, [Boolean(terminalOpen)]);

  if (!terminalOpen) return null;

  const panel = (
    <div
      className={variant === "dock" ? "herdr-modal-panel herdr-dock-panel" : "herdr-modal-panel"}
      onClick={(e) => e.stopPropagation()}
    >
        <header data-herdr-chrome className="herdr-modal-header">
          <div className="herdr-modal-header__meta min-w-0">
            <div className="herdr-modal-eyebrow">herdr · Esc / Close detaches (pane keeps running)</div>
            <div className="herdr-modal-title truncate">{terminalOpen.title}</div>
            <div className="herdr-modal-status truncate">
              {terminalOpen.herdr.host}
              {terminalOpen.herdr.paneId ? ` · ${terminalOpen.herdr.paneId}` : ""}
              {geom.cols ? ` · ${geom.cols}×${geom.rows}` : ""}
              {" · "}
              {status}
              {conn?.state ? ` · ${conn.state}` : ""}
            </div>
          </div>
          <div data-herdr-chrome className="herdr-modal-actions">
            {(conn?.state === "failed" || conn?.state === "lost" || conn?.state === "degraded") && (
              <button
                type="button"
                data-herdr-chrome
                className="herdr-modal-btn"
                onClick={() => void recreateHerdrPane(terminalOpen.nodeId, terminalOpen.herdr)}
              >
                recreate
              </button>
            )}
            <button
              type="button"
              data-herdr-chrome
              className="herdr-modal-btn herdr-modal-btn--primary"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeHerdrTerminal();
              }}
            >
              Close
            </button>
          </div>
        </header>

        <div
          ref={hostRef}
          className="herdr-xterm herdr-modal-body"
          onMouseDown={() => {
            // Keep window key handler as the input path; no focus requirement.
          }}
        />
    </div>
  );

  if (variant === "dock") return panel;

  return createPortal(
    <div
      className="herdr-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label="Herdr terminal"
    >
      {/* Backdrop */}
      <button
        type="button"
        className="herdr-modal-backdrop"
        aria-label="Close terminal"
        onClick={() => closeHerdrTerminal()}
      />
      {panel}
    </div>,
    document.body,
  );
}

/**
 * Full-window herdr work surface (portaled to document.body so app chrome
 * cannot clip it). Yields to WorkSurfaceDock whenever the dock holds the
 * herdr slot — one render host at a time, one control stream always.
 */
export function HerdrTerminalModal() {
  const registry = use$(dock$.registry);
  if (registry.surfaces.some((s) => s.kind === "herdr")) return null;
  return <HerdrTerminalPanel variant="modal" />;
}
