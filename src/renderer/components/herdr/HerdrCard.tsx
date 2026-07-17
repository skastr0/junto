import { useEffect, useRef, type SyntheticEvent } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { HerdrMirrorEvent, HerdrObserveTouchInput } from "@shared/ipc";
import { herdrActivity } from "../../lib/activity";
import {
  connectionStateOf,
  herdr$,
  openHerdrTerminal,
  refreshHerdrMeta,
  subscribeHerdrMirror,
} from "../../lib/herdr-state";
import { killHerdrPane, killHerdrTab, recreateHerdrPane } from "../../lib/herdr-actions";
import { getVellumApi } from "../../lib/vellum-api";
import { DIM, INK } from "../../lib/theme";
import { ActivityMarkFromSpec } from "../ActivityMark";

type HerdrCardApi = ReturnType<typeof getVellumApi> & {
  herdrObserveTouch?: (input: HerdrObserveTouchInput) => Promise<{ readonly pooled: boolean }>;
  onHerdrMirrorEvent?: (listener: (event: HerdrMirrorEvent) => void) => () => void;
};

// Pre-warm the observe pool at most once per 30s per terminal on hover intent.
const PREWARM_THROTTLE_MS = 30_000;
// Coalesce pointerdown+click (and rapid double-press) into one open.
const OPEN_GUARD_MS = 700;

export function HerdrCard({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const metaCache = use$(herdr$.metaByNodeId[node.id]);
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  const host = herdr?.host ?? "";
  const mirror = use$(herdr$.mirrorByHost[host]);
  const fresh = mirror?.fresh ?? false;
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "herdr";
  const preWarmRef = useRef<{ terminalId: string; at: number } | null>(null);
  const openGuardRef = useRef(0);

  // One app-wide freshness subscription (idempotent across card mounts).
  useEffect(() => {
    subscribeHerdrMirror();
  }, []);

  // Push: a mirror "change" for this host refreshes meta the instant it lands.
  useEffect(() => {
    if (!herdr?.host || !herdr.paneId) return;
    const api = getVellumApi() as HerdrCardApi | undefined;
    if (!api?.onHerdrMirrorEvent) return;
    const targetHost = herdr.host;
    return api.onHerdrMirrorEvent((event) => {
      if (event.hostId === targetHost && event.kind === "change") {
        void refreshHerdrMeta(node.id, herdr);
      }
    });
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId]);

  // Poll only as a fallback while the mirror is stale — a fresh host is
  // push-driven, so drop the 12s interval entirely.
  useEffect(() => {
    if (!herdr?.paneId) return;
    void refreshHerdrMeta(node.id, herdr);
    if (fresh) return;
    const timer = window.setInterval(() => {
      void refreshHerdrMeta(node.id, herdr);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId, fresh]);

  if (!herdr) {
    return <div className="text-xs text-slate-500">herdr unbound</div>;
  }

  const meta = metaCache?.meta;
  const agent = meta?.agent ?? herdr.label;
  const agentStatus = meta?.agentStatus;
  const cwd = meta?.cwd;
  const preview = meta?.preview;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const activity = herdrActivity({
    agentStatus,
    metaStatus: metaCache?.status,
    connState,
  });

  const open = () => {
    openHerdrTerminal(node.id, herdr, rawName);
  };

  // Open on press (pointerdown) with an onClick fallback for keyboard; the guard
  // coalesces the pointerdown+click pair into a single open.
  const guardedOpen = (e: SyntheticEvent) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - openGuardRef.current < OPEN_GUARD_MS) return;
    openGuardRef.current = now;
    open();
  };

  // Intent pre-warm: hovering the card pre-opens a read-only frame stream so
  // the terminal paints from retained frames when actually opened.
  const preWarm = () => {
    const terminalId = herdr.terminalId;
    if (!terminalId) return;
    const now = Date.now();
    const last = preWarmRef.current;
    if (last && last.terminalId === terminalId && now - last.at < PREWARM_THROTTLE_MS) return;
    preWarmRef.current = { terminalId, at: now };
    const api = getVellumApi() as HerdrCardApi | undefined;
    void api?.herdrObserveTouch?.({
      hostId: herdr.host,
      session: herdr.session ?? null,
      terminalId,
      cols: 120,
      rows: 32,
    });
  };

  return (
    <div
      className="flex h-full w-full flex-col justify-between overflow-hidden"
      onPointerEnter={preWarm}
    >
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
            herdr
          </span>
          <ActivityMarkFromSpec
            spec={
              metaCache?.error
                ? { ...activity, label: metaCache.error }
                : activity
            }
          />
        </div>
        <button
          type="button"
          className="nodrag nopan mt-1 w-full truncate text-left text-[14px] font-semibold leading-snug"
          style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          title="Open terminal"
          onPointerDown={guardedOpen}
          onClick={guardedOpen}
        >
          {rawName}
        </button>
        <div className="mt-0.5 text-[10px] tabular-nums" style={{ color: DIM }}>
          {herdr.host}
          {herdr.session ? ` · ${herdr.session}` : ""}
          {herdr.workspaceId ? ` · ${herdr.workspaceId}` : ""}
          {herdr.tabId ? `/${herdr.tabId.split(":").pop()}` : ""}
        </div>
      </div>
      <div className="space-y-1">
        {agent ? (
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] text-[#EDE6DA]">{agent}</span>
          </div>
        ) : null}
        <div className="line-clamp-1 text-[10px]" style={{ color: DIM }} title={cwd ?? preview ?? ""}>
          {cwd || preview || herdr.paneId || "no meta yet"}
        </div>
        <div className="nodrag nopan flex flex-wrap gap-1 pt-0.5">
          <button
            type="button"
            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
            onPointerDown={guardedOpen}
            onClick={guardedOpen}
          >
            open
          </button>
          <button
            type="button"
            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              void killHerdrPane(node.id, herdr);
            }}
          >
            kill pane
          </button>
          {herdr.tabId ? (
            <button
              type="button"
              className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                void killHerdrTab(node.id, herdr);
              }}
            >
              kill tab
            </button>
          ) : null}
          {(connState === "lost" || connState === "failed") && (
            <button
              type="button"
              className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-amber-200 hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                void recreateHerdrPane(node.id, herdr);
              }}
            >
              recreate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
