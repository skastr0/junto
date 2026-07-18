import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode, EtherHerdr } from "@shared/canvas";
import type { HerdrMirrorEvent, HerdrObserveTouchInput } from "@shared/ipc";
import { herdrActivity } from "../../lib/activity";
import {
  connectionStateOf,
  herdr$,
  openHerdrTerminal,
  refreshHerdrMeta,
  subscribeHerdrMirror,
} from "../../lib/herdr-state";
import { harnessDisplayName } from "../../lib/harness-icons";
import { editText } from "../../lib/mutations";
import { getVellumApi } from "../../lib/vellum-api";
import { DIM, INK, withAlpha } from "../../lib/theme";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { HarnessMark } from "./HarnessMark";

type HerdrCardApi = ReturnType<typeof getVellumApi> & {
  herdrObserveTouch?: (input: HerdrObserveTouchInput) => Promise<{ readonly pooled: boolean }>;
  onHerdrMirrorEvent?: (listener: (event: HerdrMirrorEvent) => void) => () => void;
};

// Pre-warm the observe pool at most once per 30s per terminal on hover intent.
const PREWARM_THROTTLE_MS = 30_000;
// Coalesce pointerdown+click (and rapid double-press) into one open.
const OPEN_GUARD_MS = 700;

// Basename of a cwd for the hero fallback / bottom line ("/a/b/" → "b").
const cwdBaseOf = (cwd: string | undefined): string | undefined => {
  if (!cwd) return undefined;
  return cwd.replace(/\/+$/, "").split("/").pop() ?? undefined;
};

// Placeholder/auto-derived first lines carry no identity — the hero falls back
// to live meta for these. An explicit (operator-typed) label always wins.
const isAutoDerivedLabel = (
  label: string,
  herdr: EtherHerdr,
  liveAgent: string | undefined,
): boolean => {
  const trimmed = label.trim();
  if (!trimmed || trimmed.toLowerCase() === "herdr") return true;
  const paneId = herdr.paneId;
  if (!paneId) return false;
  if (trimmed === paneId || trimmed === `${herdr.host} · ${paneId}`) return true;
  if (liveAgent && trimmed === `${liveAgent} · ${paneId}`) return true;
  if (herdr.label && trimmed === `${herdr.label} · ${paneId}`) return true;
  return false;
};

// First-line rename for the hero: auto-focus+select, Enter/blur commits via
// editText (parent preserves lines below the first), Escape discards. The
// fired ref coalesces Enter→blur and Escape→blur into one finish.
function RenameInput({
  initial,
  onCommit,
  onDone,
}: {
  readonly initial: string;
  readonly onCommit: (firstLine: string) => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const firedRef = useRef(false);

  const finish = (commit: boolean) => {
    if (firedRef.current) return;
    firedRef.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) onCommit(next);
    onDone();
  };

  return (
    <input
      ref={(el) => {
        el?.focus();
        el?.select();
      }}
      aria-label="Rename agent node"
      className="nodrag nopan nowheel w-full truncate bg-transparent text-left text-[14px] font-semibold leading-snug outline-none"
      style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

export function HerdrCard({
  node,
  selected,
  renaming,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly renaming: boolean;
  readonly onRequestRename: () => void;
  readonly onRenameDone: () => void;
}) {
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

  // Push: default-session cards only. Mirror is default-session; named sessions
  // are separate servers and must not fan out CLI meta on default events (VL-030).
  const pushDriven = Boolean(herdr?.host && herdr.paneId && !herdr.session && fresh);

  useEffect(() => {
    if (!herdr?.host || !herdr.paneId) return;
    if (herdr.session) return;
    const api = getVellumApi() as HerdrCardApi | undefined;
    if (!api?.onHerdrMirrorEvent) return;
    const targetHost = herdr.host;
    return api.onHerdrMirrorEvent((event) => {
      if (event.hostId === targetHost && event.kind === "change") {
        void refreshHerdrMeta(node.id, herdr);
      }
    });
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId]);

  // Poll when not push-driven: named-session cards always poll (their host
  // `fresh` is the *default* mirror and is not their data path). Default-session
  // cards poll only while the host mirror is stale.
  useEffect(() => {
    if (!herdr?.paneId) return;
    void refreshHerdrMeta(node.id, herdr);
    if (pushDriven) return;
    const timer = window.setInterval(() => {
      void refreshHerdrMeta(node.id, herdr);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId, pushDriven]);

  if (!herdr) {
    return <div className="text-xs text-slate-500">herdr unbound</div>;
  }

  const meta = metaCache?.meta;
  const agent = meta?.agent ?? herdr.label;
  const agentStatus = meta?.agentStatus;
  const cwd = meta?.cwd;
  const cwdBase = cwdBaseOf(cwd);
  const preview = meta?.preview;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const activity = herdrActivity({
    agentStatus,
    metaStatus: metaCache?.status,
    connState,
  });

  // Hero: explicit label wins; placeholder/auto-derived labels fall back to
  // live identity (workspace label → cwd basename → harness display name).
  // Status chrome is ActivityMark only — no agentStatus text labels.
  const hero = isAutoDerivedLabel(rawName, herdr, meta?.agent)
    ? (meta?.workspaceLabel ?? cwdBase ?? harnessDisplayName(agent))
    : rawName;

  const tabShort = herdr.tabId ? herdr.tabId.split(":").pop() : undefined;
  const crumbs = [
    herdr.host,
    herdr.session ?? undefined,
    meta?.workspaceLabel ?? herdr.workspaceId,
    meta?.tabLabel ?? tabShort,
  ].filter((s): s is string => Boolean(s));
  const crumbTitle = [herdr.host, herdr.session ?? undefined, herdr.workspaceId, herdr.tabId]
    .filter((s): s is string => Boolean(s))
    .join(" › ");

  const bottomFallback = preview ?? herdr.paneId ?? "no meta yet";
  const bottomTitle = cwd ? (preview ? `${cwd} — ${preview}` : cwd) : bottomFallback;

  const open = () => {
    openHerdrTerminal(node.id, herdr, rawName);
  };

  // Time-based coalescing shared by every open trigger: pointerdown+click
  // (and rapid double-press) collapse into a single open().
  const timeGuardedOpen = () => {
    const now = Date.now();
    if (now - openGuardRef.current < OPEN_GUARD_MS) return;
    openGuardRef.current = now;
    open();
  };

  // Open on press (pointerdown) with an onClick fallback for keyboard. Once the
  // card is selected the press is inert — double-click renames, the ghost
  // button opens.
  const guardedOpen = (e: SyntheticEvent) => {
    e.stopPropagation();
    if (selected) return;
    timeGuardedOpen();
  };

  // Ghost open button: same coalescing guard as the hero, but never suppressed
  // by selection — it is the open path while the card is selected.
  const ghostGuardedOpen = (e: SyntheticEvent) => {
    e.stopPropagation();
    timeGuardedOpen();
  };

  const commitRename = (firstLine: string) => {
    if (node.type !== "text") return;
    const rest = node.text.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${firstLine}\n${rest}` : firstLine);
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
      className="group flex h-full w-full flex-col justify-between overflow-hidden"
      onPointerEnter={preWarm}
    >
      <div>
        <div className="flex items-center gap-2">
          <HarnessMark agent={agent} size={28} focused={meta?.focused === true} />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <RenameInput initial={rawName} onCommit={commitRename} onDone={onRenameDone} />
            ) : (
              <button
                type="button"
                className="nodrag nopan w-full truncate text-left text-[14px] font-semibold leading-snug"
                style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
                title={selected ? "double-click to rename" : "open terminal"}
                onPointerDown={guardedOpen}
                onClick={guardedOpen}
                onDoubleClick={(event) => {
                  if (!selected) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onRequestRename();
                }}
              >
                {hero}
              </button>
            )}
            <div className="truncate text-[11px]" style={{ color: DIM }}>
              {harnessDisplayName(agent)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="open terminal"
              title="open terminal"
              className="nodrag nopan grid size-[22px] place-items-center rounded text-cyan-300/60 opacity-0 transition hover:bg-white/10 hover:text-cyan-200 group-hover:opacity-100"
              onPointerDown={ghostGuardedOpen}
              onClick={ghostGuardedOpen}
            >
              <SquareTerminal size={12} />
            </button>
            <ActivityMarkFromSpec
              spec={
                metaCache?.error
                  ? { ...activity, label: metaCache.error }
                  : activity
              }
            />
          </div>
        </div>
        <div className="mt-0.5 truncate text-[10px] tabular-nums" style={{ color: DIM }} title={crumbTitle}>
          {crumbs.join(" › ")}
        </div>
      </div>
      <div className="line-clamp-1 text-[10px]" style={{ color: DIM }} title={bottomTitle}>
        {cwd ? (
          <>
            <span style={{ color: withAlpha(INK, 0.6) }}>{cwdBase}</span>
            {preview ? <span style={{ color: DIM }}>{` — ${preview}`}</span> : null}
          </>
        ) : (
          bottomFallback
        )}
      </div>
    </div>
  );
}
