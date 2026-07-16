import { useEffect, useRef, useState } from "react";
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

/** Map a browser keyboard event to PTY bytes (when not using xterm onData). */
const keyEventToPty = (e: KeyboardEvent): string | null => {
  if (e.isComposing) return null;
  if (e.metaKey || e.altKey) return null; // leave OS shortcuts alone

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
    case "Escape":
      return "\x1b";
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
  herdrStreamScroll: (streamId: string, delta: number) => Promise<unknown>;
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
 * Interactive herdr work surface.
 *
 * Architecture:
 * - xterm is DISPLAY ONLY (disableStdin) — reliable for ANSI re-blit frames
 * - a transparent capture layer owns keyboard + wheel and talks IPC
 * - close is always synchronous (UI first; stream detach in background)
 */
export function HerdrTerminalModal() {
  const terminalOpen = use$(herdr$.terminal);
  const nodeId = terminalOpen?.nodeId ?? "";
  const conn = use$(herdr$.connectionByNodeId[nodeId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const streamIdRef = useRef<string | undefined>(undefined);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("connecting…");

  // Escape / Cmd-W always closes — never trap the operator.
  useEffect(() => {
    if (!terminalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w")) {
        e.preventDefault();
        e.stopPropagation();
        closeHerdrTerminal();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [Boolean(terminalOpen)]);

  // Stream + xterm lifecycle
  useEffect(() => {
    if (!terminalOpen || !hostRef.current) return;
    const api = getVellumApi() as HerdrApi | undefined;
    const hostEl = hostRef.current;
    if (!api?.herdrStreamOpen || !api.onHerdrStreamEvent) {
      setStatus("herdr stream API unavailable");
      return;
    }

    const term = new Terminal({
      // Display path only — keyboard is owned by the capture textarea.
      disableStdin: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0c0b0a",
        foreground: "#EDE6DA",
        cursor: "#E8A33D",
      },
      allowProposedApi: true,
      scrollback: 0,
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

    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // zero size
      }
    };

    requestAnimationFrame(() => {
      fitNow();
      captureRef.current?.focus();
    });

    const sendPty = (raw: string) => {
      const id = streamIdRef.current;
      if (!id || !raw) return;
      void api.herdrStreamInput(id, utf8ToBase64(raw)).then((res) => {
        if (res && res.ok === false && res.error) setStatus(`input failed: ${res.error}`);
      });
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

      fitNow();
      const cols = Math.max(20, term.cols || 80);
      const rows = Math.max(5, term.rows || 24);
      setStatus("attaching control…");
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
      setStatus("connected · type here · Esc closes");
      setConnectionEvent(terminalOpen.nodeId, { type: "ok" });
      captureRef.current?.focus();
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
      fitNow();
      const id = streamIdRef.current;
      if (!id) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void api.herdrStreamResize(id, term.cols, term.rows);
      }, 80);
    };
    window.addEventListener("resize", scheduleResize);
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => scheduleResize());
      resizeObs.observe(hostEl);
    }

    // Capture layer owns keys (attached outside this effect via captureRef).
    // Expose sendPty on the element for the onKeyDown handler below.
    (hostEl as HTMLDivElement & { __sendPty?: (s: string) => void }).__sendPty = sendPty;

    void openStream();

    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener("resize", scheduleResize);
      resizeObs?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      const id = streamIdRef.current;
      if (id) void api.herdrStreamClose(id);
      streamIdRef.current = undefined;
      delete (hostEl as HTMLDivElement & { __sendPty?: unknown }).__sendPty;
      term.dispose();
      termRef.current = null;
    };
  }, [terminalOpen?.nodeId, terminalOpen?.herdr.paneId, terminalOpen?.herdr.terminalId]);

  // Keep capture layer focused whenever the modal is open.
  useEffect(() => {
    if (!terminalOpen) return;
    const t = window.setInterval(() => {
      const el = captureRef.current;
      if (!el) return;
      if (document.activeElement === el) return;
      // Don't steal focus from the close button while user is clicking chrome.
      const a = document.activeElement;
      if (a instanceof HTMLElement && a.closest("[data-herdr-chrome]")) return;
      el.focus({ preventScroll: true });
    }, 400);
    return () => window.clearInterval(t);
  }, [Boolean(terminalOpen)]);

  if (!terminalOpen) return null;

  const sendFromCapture = (raw: string) => {
    const id = streamIdRef.current;
    if (!id || !raw) return;
    const api = getVellumApi() as HerdrApi | undefined;
    void api?.herdrStreamInput?.(id, utf8ToBase64(raw));
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/75 p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Herdr terminal"
    >
      {/* Backdrop click closes */}
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-default bg-transparent"
        aria-label="Close terminal"
        onClick={() => closeHerdrTerminal()}
      />

      <div
        className="relative z-10 mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0c0b0a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          data-herdr-chrome
          className="relative z-30 flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#141210] px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: HUE.steel }}>
              herdr terminal · Esc / close detaches (pane keeps running)
            </div>
            <div className="truncate text-sm font-semibold text-[#EDE6DA]">{terminalOpen.title}</div>
            <div className="truncate text-[11px] text-slate-500">
              {terminalOpen.herdr.host}
              {terminalOpen.herdr.session ? ` · ${terminalOpen.herdr.session}` : ""}
              {terminalOpen.herdr.paneId ? ` · ${terminalOpen.herdr.paneId}` : ""}
              {" · "}
              {status}
              {conn?.state ? ` · ${conn.state}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(conn?.state === "failed" || conn?.state === "lost" || conn?.state === "degraded") && (
              <button
                type="button"
                data-herdr-chrome
                className="rounded px-2 py-1 text-xs text-amber-200 hover:bg-white/10"
                onClick={() => void recreateHerdrPane(terminalOpen.nodeId, terminalOpen.herdr)}
              >
                recreate
              </button>
            )}
            <button
              type="button"
              data-herdr-chrome
              className="rounded border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-[#EDE6DA] hover:bg-white/15"
              onPointerDown={(e) => {
                // Pointer-down so we win even if something steals click.
                e.preventDefault();
                e.stopPropagation();
                closeHerdrTerminal();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeHerdrTerminal();
              }}
            >
              Close
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {/* Display surface */}
          <div ref={hostRef} className="herdr-xterm absolute inset-0 overflow-hidden p-1" />

          {/* Input capture — always on top of xterm, near-invisible, owns keyboard */}
          <textarea
            ref={captureRef}
            aria-label="Terminal input"
            className="absolute inset-0 z-20 h-full w-full resize-none border-0 bg-transparent p-0 text-transparent caret-transparent outline-none"
            style={{ color: "transparent", caretColor: "transparent" }}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value=""
            onChange={() => {
              // Prefer onKeyDown for special keys; onChange covers paste/IME leftovers.
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeHerdrTerminal();
                return;
              }
              // Let the capture layer own the key; do not bubble to canvas.
              e.stopPropagation();
              if (e.metaKey || e.altKey) return;

              // Paste handled separately
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;

              const pty = keyEventToPty(e.nativeEvent);
              if (pty != null) {
                e.preventDefault();
                sendFromCapture(pty);
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const text = e.clipboardData.getData("text");
              if (text) sendFromCapture(text);
            }}
            onWheel={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const id = streamIdRef.current;
              const api = getVellumApi() as HerdrApi | undefined;
              if (!id || !api?.herdrStreamScroll) return;
              const lines = Math.max(1, Math.min(12, Math.round(Math.abs(e.deltaY) / 40) || 1));
              const signed = e.deltaY < 0 ? -lines : lines;
              void api.herdrStreamScroll(id, signed);
            }}
          />
        </div>
      </div>
    </div>
  );
}
