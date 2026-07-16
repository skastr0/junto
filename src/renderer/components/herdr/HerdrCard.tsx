import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { connectionStateOf, herdr$, openHerdrTerminal, refreshHerdrMeta } from "../../lib/herdr-state";
import { killHerdrPane, killHerdrTab, recreateHerdrPane } from "../../lib/herdr-actions";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";

const STATUS_COLOR: Record<string, string> = {
  idle: HUE.steel,
  working: HUE.amber,
  blocked: HUE.crimson,
  done: "#5bb98c",
  unknown: DIM,
  connected: "#5bb98c",
  degraded: HUE.amber,
  lost: HUE.crimson,
  failed: HUE.crimson,
};

export function HerdrCard({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const metaCache = use$(herdr$.metaByNodeId[node.id]);
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "herdr";

  useEffect(() => {
    if (!herdr?.paneId) return;
    void refreshHerdrMeta(node.id, herdr);
    const timer = window.setInterval(() => {
      void refreshHerdrMeta(node.id, herdr);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId]);

  if (!herdr) {
    return <div className="text-xs text-slate-500">herdr unbound</div>;
  }

  const meta = metaCache?.meta;
  const agent = meta?.agent ?? herdr.label;
  const agentStatus = meta?.agentStatus;
  const cwd = meta?.cwd;
  const preview = meta?.preview;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const stale = metaCache?.status === "error" || connState === "degraded" || connState === "failed" || connState === "lost";

  const open = () => {
    openHerdrTerminal(node.id, herdr, rawName);
  };

  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
            herdr
          </span>
          <span className="flex items-center gap-1">
            {stale ? (
              <span
                className="rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase tracking-wide"
                style={{
                  color: STATUS_COLOR[connState] ?? HUE.amber,
                  borderColor: withAlpha(STATUS_COLOR[connState] ?? HUE.amber, 0.45),
                }}
                title={metaCache?.error ?? connState}
              >
                {connState}
              </span>
            ) : (
              <span
                className="size-[5px] rounded-full"
                style={{ background: STATUS_COLOR.connected, boxShadow: `0 0 6px ${withAlpha(STATUS_COLOR.connected, 0.6)}` }}
                title="connected"
              />
            )}
          </span>
        </div>
        <button
          type="button"
          className="nodrag nopan mt-1 w-full truncate text-left text-[14px] font-semibold leading-snug"
          style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          title="Open terminal"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
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
            {agentStatus ? (
              <span
                className="shrink-0 rounded-full border px-1.5 py-px text-[8px] uppercase tracking-wide"
                style={{
                  color: STATUS_COLOR[agentStatus] ?? DIM,
                  borderColor: withAlpha(STATUS_COLOR[agentStatus] ?? DIM, 0.4),
                }}
              >
                {agentStatus}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="line-clamp-1 text-[10px]" style={{ color: DIM }} title={cwd ?? preview ?? ""}>
          {cwd || preview || herdr.paneId || "no meta yet"}
        </div>
        <div className="nodrag nopan flex flex-wrap gap-1 pt-0.5">
          <button
            type="button"
            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
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
