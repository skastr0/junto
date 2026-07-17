import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { extractHerdrClipboardImage } from "../../lib/herdr-clipboard-image";
import { dock$ } from "../../lib/dock-state";
import { getVellumApi } from "../../lib/vellum-api";
import { ActivityMark } from "../ActivityMark";
import { FocusSurface } from "../FocusSurface";

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

type HerdrApi = NonNullable<ReturnType<typeof getVellumApi>> & {
  herdrStreamOpen: (input: {
    hostId: string;
    session?: string | null;
    terminalId: string;
    cols: number;
    rows: number;
    takeover?: boolean;
  }) => Promise<{ ok: boolean; streamId?: string; message?: string; retained?: ReadonlyArray<string> }>;
  herdrObserveRetained?: (terminalId: string) => Promise<ReadonlyArray<string>>;
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
      // Close on ⌘W/Ctrl+W only — Escape belongs to the terminal (agent TUIs
      // use it to interrupt); Close button and backdrop remain pointer exits.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
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

    const sendClipboardImage = (
      image: { readonly extension: string; readonly dataBase64: string; readonly byteLength: number },
    ) => {
      const id = streamIdRef.current;
      const api = apiRef.current;
      if (!id || !api?.herdrStreamPasteImage) {
        setStatus("image paste dropped · stream not ready");
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
              ? `image path pasted · ${path}`
              : `image path pasted · ${image.extension} · ${image.byteLength} B`,
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
    // xterm is display-only, but with scrollback: 0 its screen-element wheel
    // listener consumes wheel events itself (alt-buffer arrow synthesis) and
    // cancels them before they bubble to hostEl. Returning false here makes
    // xterm ignore wheel entirely; the modal owns all pointer input.
    term.attachCustomWheelEventHandler(() => false);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObs: ResizeObserver | undefined;

    // Retained-frame placeholder (VL-020): paint the observe pool's last known
    // pixels immediately, dimmed; the control stream's first full frame resets
    // the terminal and swaps to live at full opacity.
    let liveFrameSeen = false;
    let placeholderPainted = false;
    const writePlaceholder = (frames: ReadonlyArray<string> | undefined): void => {
      if (cancelled || liveFrameSeen || placeholderPainted || !frames?.length) return;
      placeholderPainted = true;
      hostEl.style.transition = "opacity 160ms ease";
      hostEl.style.opacity = "0.55";
      for (const bytes of frames) term.write(base64ToUtf8(bytes));
    };
    const markLive = (): void => {
      liveFrameSeen = true;
      hostEl.style.opacity = "1";
    };
    // Cached terminal id is good enough for a dimmed preview — the live id is
    // re-resolved in openStream; a stale preview is wiped by the first full frame.
    if (terminalOpen.herdr.terminalId && api.herdrObserveRetained) {
      void api
        .herdrObserveRetained(terminalOpen.herdr.terminalId)
        .then(writePlaceholder)
        .catch(() => undefined);
    }

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

      // Terminal ids regenerate whenever the herdr server restarts or live-
      // hands-off; a cached id then fails every reconnect and the modal spins
      // in an attach loop. The pane id is the stable handle — always re-resolve
      // the live terminal id from it, falling back to the cached one.
      let terminalId: string | undefined;
      if (herdr.paneId) {
        const meta = await api.herdrGetMeta(herdr.host, herdr.session ?? null, herdr.paneId);
        if (cancelled) return;
        terminalId = meta.data?.terminalId;
      }
      terminalId ||= herdr.terminalId;
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
      // Pool handoff: frames captured before the observe stream was paused.
      writePlaceholder(opened.retained);
      streamIdRef.current = opened.streamId;
      setTerminalStreamId(opened.streamId);
      setStatus(`connected · ${cols}×${rows} · type · ⌘W closes`);
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
        if (!liveFrameSeen && placeholderPainted) term.reset(); // wipe placeholder
        markLive();
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
        setStatus("image drop dropped · stream not ready");
        return;
      }
      void (async () => {
        const image = await extractHerdrClipboardImage(e.dataTransfer);
        if (image && "error" in image) {
          setStatus(`image drop failed: ${image.error}`);
          return;
        }
        if (!image) {
          setStatus("drop ignored · not an image");
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
              ? `image path pasted · ${path}`
              : `image path pasted · ${image.extension} · ${image.byteLength} B`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(`image drop failed: ${msg}`);
        }
      })();
    };

    hostEl.addEventListener("dragover", onDragOver);
    hostEl.addEventListener("drop", onDrop);

    void openStream();

    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener("resize", scheduleResize);
      resizeObs?.disconnect();
      hostEl.removeEventListener("wheel", onWheel, { capture: true });
      hostEl.removeEventListener("dragover", onDragOver);
      hostEl.removeEventListener("drop", onDrop);
      if (wheelTimer) clearTimeout(wheelTimer);
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

  const chrome = (
    <>
      <header data-herdr-chrome className="herdr-modal-header">
        <div className="herdr-modal-header__meta min-w-0">
          <div className="herdr-modal-eyebrow">
            herdr · ⌘W / Close detaches (pane keeps running) · Esc goes to the terminal
          </div>
          <div className="herdr-modal-title truncate">{terminalOpen.title}</div>
          <div className="herdr-modal-status truncate">
            <ActivityMark
              mode={conn?.state === "connected" ? "static" : "wave"}
              tone="amber"
              size="inline"
              label={conn?.state === "connected" ? "connected" : "connecting"}
            />{" "}
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
    </>
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
      onClose={() => closeHerdrTerminal()}
      closeOnEscape={false}
      closeOnBackdrop
    >
      {chrome}
    </FocusSurface>
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
