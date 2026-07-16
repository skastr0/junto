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
  setHerdrToast,
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

export function HerdrTerminalModal() {
  const terminalOpen = use$(herdr$.terminal);
  const nodeId = terminalOpen?.nodeId ?? "";
  const conn = use$(herdr$.connectionByNodeId[nodeId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const streamIdRef = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState("connecting…");

  useEffect(() => {
    if (!terminalOpen || !hostRef.current) return;
    const api = getVellumApi() as
      | (ReturnType<typeof getVellumApi> & {
          herdrStreamOpen: (input: {
            hostId: string;
            session?: string | null;
            terminalId: string;
            cols: number;
            rows: number;
            takeover?: boolean;
          }) => Promise<{ ok: boolean; streamId?: string; message?: string }>;
          herdrStreamInput: (streamId: string, data: string) => Promise<unknown>;
          herdrStreamResize: (streamId: string, cols: number, rows: number) => Promise<unknown>;
          herdrStreamScroll: (streamId: string, delta: number) => Promise<unknown>;
          herdrStreamClose: (streamId: string) => Promise<unknown>;
          herdrEnsureServer: (hostId: string, session?: string | null) => Promise<{ ok: boolean; message?: string }>;
          herdrGetMeta: (
            hostId: string,
            session: string | null | undefined,
            paneId: string,
          ) => Promise<{ ok: boolean; data?: { terminalId?: string }; message?: string }>;
          onHerdrStreamEvent: (listener: (event: {
            streamId: string;
            type: "frame" | "closed" | "error";
            bytes?: string;
            full?: boolean;
            reason?: string;
            message?: string;
          }) => void) => () => void;
        })
      | undefined;

    if (!api?.herdrStreamOpen || !api.onHerdrStreamEvent) {
      setStatus("herdr stream API unavailable");
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0c0b0a",
        foreground: "#EDE6DA",
        cursor: "#E8A33D",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    let cancelled = false;
    let unsub = () => undefined as void;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const openStream = async () => {
      setStatus("ensuring server…");
      const herdr = terminalOpen.herdr;
      const ensure = await api.herdrEnsureServer(herdr.host, herdr.session ?? null);
      if (!ensure.ok) {
        setStatus(ensure.message ?? "ensure failed");
        setConnectionEvent(terminalOpen.nodeId, { type: "host_unreachable" });
        return;
      }

      let terminalId = herdr.terminalId;
      if (!terminalId && herdr.paneId) {
        const meta = await api.herdrGetMeta(herdr.host, herdr.session ?? null, herdr.paneId);
        terminalId = meta.data?.terminalId;
      }
      if (!terminalId) {
        setStatus("no terminal id on bound pane");
        setConnectionEvent(terminalOpen.nodeId, { type: "pane_missing" });
        return;
      }

      fit.fit();
      const cols = term.cols;
      const rows = term.rows;
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
      setStatus("connected");
      setConnectionEvent(terminalOpen.nodeId, { type: "ok" });
    };

    unsub = api.onHerdrStreamEvent((event) => {
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
        // Bounded auto-reconnect when modal still open.
        if (canAutoReconnect(terminalOpen.nodeId)) {
          setConnectionEvent(terminalOpen.nodeId, { type: "reconnect_start" });
          setStatus("reconnecting…");
          void openStream();
        } else {
          setConnectionEvent(terminalOpen.nodeId, { type: "reconnect_exhausted" });
        }
      }
    });

    const dataDisp = term.onData((data) => {
      const id = streamIdRef.current;
      if (!id) return;
      void api.herdrStreamInput(id, utf8ToBase64(data));
    });

    const onResize = () => {
      fit.fit();
      const id = streamIdRef.current;
      if (!id) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void api.herdrStreamResize(id, term.cols, term.rows);
      }, 80);
    };
    window.addEventListener("resize", onResize);

    const onWheel = (e: WheelEvent) => {
      const id = streamIdRef.current;
      if (!id) return;
      const delta = Math.sign(e.deltaY);
      if (delta !== 0) void api.herdrStreamScroll(id, delta);
    };
    hostRef.current.addEventListener("wheel", onWheel, { passive: true });

    void openStream();

    return () => {
      cancelled = true;
      unsub();
      dataDisp.dispose();
      window.removeEventListener("resize", onResize);
      hostRef.current?.removeEventListener("wheel", onWheel);
      if (resizeTimer) clearTimeout(resizeTimer);
      const id = streamIdRef.current;
      if (id) void api.herdrStreamClose(id);
      streamIdRef.current = undefined;
      term.dispose();
      xtermRef.current = null;
    };
  }, [terminalOpen?.nodeId, terminalOpen?.herdr.paneId, terminalOpen?.herdr.terminalId]);

  if (!terminalOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/70 p-4" role="dialog" aria-label="Herdr terminal">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0c0b0a] shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: HUE.steel }}>
              herdr terminal · one control stream
            </div>
            <div className="truncate text-sm font-semibold text-[#EDE6DA]">{terminalOpen.title}</div>
            <div className="text-[11px] text-slate-500">
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
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-amber-200 hover:bg-white/10"
                  onClick={() => {
                    setConnectionEvent(terminalOpen.nodeId, { type: "reconnect_start" });
                    setHerdrToast("Reconnect: close and reopen modal");
                    void closeHerdrTerminal().then(() => {
                      // Re-open same binding
                      herdr$.terminal.set({ ...terminalOpen, streamId: undefined });
                    });
                  }}
                >
                  reconnect
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-amber-200 hover:bg-white/10"
                  onClick={() => void recreateHerdrPane(terminalOpen.nodeId, terminalOpen.herdr)}
                >
                  recreate
                </button>
              </>
            )}
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-[#EDE6DA]"
              onClick={() => void closeHerdrTerminal()}
            >
              close (detach stream)
            </button>
          </div>
        </div>
        <div ref={hostRef} className="min-h-0 flex-1 p-2" />
      </div>
    </div>
  );
}
