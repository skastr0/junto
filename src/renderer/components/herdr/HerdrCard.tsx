import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode, EtherHerdr } from "@shared/canvas";
import type { HerdrObserveTouchInput } from "@shared/ipc";
import { herdrActivity } from "../../lib/activity";
import {
  connectionStateOf,
  herdr$,
  onHerdrMirrorChange,
  openHerdrTerminal,
  probeHerdrServiceMap,
  refreshHerdrMeta,
  registerHerdrMetaPoll,
  scheduleRefreshHerdrMeta,
  subscribeHerdrMirror,
  subscribeHerdrServiceMap,
} from "../../lib/herdr-state";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { harnessDisplayName } from "../../lib/harness-icons";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { resolveNodeHostId } from "@shared/station";
import { addNode, editText } from "../../lib/mutations";
import { makePageNode } from "../../lib/node-factories";
import { resolveAuthoredPageHost } from "../../lib/page-authoring";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";
import { HarnessMark } from "./HarnessMark";

type HerdrCardApi = ReturnType<typeof getVellumApi> & {
  herdrObserveTouch?: (
    input: HerdrObserveTouchInput,
  ) => Promise<{ readonly pooled: boolean }>;
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
  if (trimmed === paneId || trimmed === `${herdr.host} · ${paneId}`)
    return true;
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
      className="nodrag nopan nowheel w-full truncate bg-transparent text-left font-mono text-[14px] font-semibold leading-snug outline-none"
      style={{ color: INK }}
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
  const rawName =
    (node.type === "text" ? node.text : "").split("\n")[0] ?? "herdr";
  const preWarmRef = useRef<{ terminalId: string; at: number } | null>(null);
  const openGuardRef = useRef(0);

  // One app-wide freshness subscription (idempotent across card mounts).
  useEffect(() => {
    subscribeHerdrMirror();
    subscribeHerdrServiceMap();
  }, []);

  // Push: default-session cards only. Mirror is default-session; named sessions
  // are separate servers and must not fan out CLI meta on default events (VL-030).
  const pushDriven = Boolean(
    herdr?.host && herdr.paneId && !herdr.session && fresh,
  );

  useEffect(() => {
    if (!herdr?.host || !herdr.paneId) return;
    if (herdr.session) return;
    const targetHost = herdr.host;
    return onHerdrMirrorChange((event) => {
      if (event.hostId === targetHost && event.kind === "change") {
        // Debounce: focus/status flaps can emit many change events per second;
        // immediate refresh was the FOCUSED/PROCESS inspector thrash pump.
        scheduleRefreshHerdrMeta(node.id, herdr);
      }
    });
  }, [node.id, herdr?.host, herdr?.paneId, herdr?.session, herdr?.terminalId]);

  // Poll when not push-driven: named-session cards always poll (their host
  // `fresh` is the *default* mirror and is not their data path). Default-session
  // cards poll only while the host mirror is stale. Shared poller in herdr-state
  // (one 12s timer for all registered cards — not per-card intervals).
  //
  // onlyRenderVisibleElements remounts cards at the viewport edge during pan —
  // never fire IPC on that mount while the viewport is busy.
  useEffect(() => {
    if (!herdr?.paneId) return;
    let unregPoll: (() => void) | undefined;
    let cancelled = false;
    const arm = () => {
      if (cancelled) return;
      void refreshHerdrMeta(node.id, herdr);
      if (!pushDriven) unregPoll = registerHerdrMetaPoll(node.id, herdr);
    };
    if (viewportBusy$.peek()) {
      const off = viewportBusy$.onChange(() => {
        if (viewportBusy$.peek()) return;
        off();
        arm();
      });
      return () => {
        cancelled = true;
        off();
        unregPoll?.();
      };
    }
    arm();
    return () => {
      cancelled = true;
      unregPoll?.();
    };
  }, [
    node.id,
    herdr?.host,
    herdr?.paneId,
    herdr?.session,
    herdr?.terminalId,
    pushDriven,
  ]);

  if (!herdr) {
    return <div className="text-xs text-faint">herdr unbound</div>;
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
  const crumbTitle = [
    herdr.host,
    herdr.session ?? undefined,
    herdr.workspaceId,
    herdr.tabId,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" › ");

  const service = meta?.service;
  const processLine =
    service?.processes?.[0]?.name ??
    service?.processes?.[0]?.cmdline?.split(/\s+/)[0] ??
    meta?.processes?.[0]?.name;
  const portLine =
    service?.ports && service.ports.length > 0
      ? `:${service.ports.map((p) => p.port).join(",")}`
      : undefined;
  const serveTag = service?.serveJoined
    ? (service.serveLabel ?? "svc")
    : undefined;
  const serviceBadge =
    service?.health === "skipped"
      ? undefined
      : service?.health === "live" || service?.health === "stale"
      ? [
          serveTag,
          processLine,
          serveTag ? undefined : portLine,
          service.health === "stale" ? "stale" : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : service?.health === "pending"
        ? [processLine, "port…"].filter(Boolean).join(" · ")
        : service?.health === "dead" && processLine
          ? `${processLine} · no port`
          : processLine;

  const bottomFallback = preview ?? herdr.paneId ?? "no meta yet";
  const bottomTitle = [
    service?.url,
    cwd ? (preview ? `${cwd} — ${preview}` : cwd) : bottomFallback,
  ]
    .filter(Boolean)
    .join("\n");

  const open = () => {
    openHerdrTerminal(node.id, herdr, rawName);
  };

  const syncService = (e: SyntheticEvent) => {
    e.stopPropagation();
    void probeHerdrServiceMap(node.id, herdr);
  };

  const openServicePage = (e: SyntheticEvent) => {
    e.stopPropagation();
    const url = service?.url;
    if (!url) return;
    const width = node.width ?? 260;
    const x = node.x + width + 40;
    const y = node.y;
    const seed = resolvePageSpawnDefaults(
      state$.doc.peek(),
      x + width / 2,
      y + 55,
    );
    const page = makePageNode(
      x,
      y,
      url,
      seed?.profile ? { profile: seed.profile } : undefined,
      // A containing region may deliberately select the browser host; absent
      // that authorial default, preserve the Herdr surface's physical host.
      resolveAuthoredPageHost(seed?.host, resolveNodeHostId(node)),
    );
    addNode(page, { focus: true });
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
  // button opens. Shift multi-select always wins over open/rename.
  const guardedOpen = (e: SyntheticEvent) => {
    if ("shiftKey" in e && (e as { shiftKey?: boolean }).shiftKey) return;
    e.stopPropagation();
    if (selected) return;
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
    if (
      last &&
      last.terminalId === terminalId &&
      now - last.at < PREWARM_THROTTLE_MS
    )
      return;
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

  const complete = activity.mode === "pulse" && activity.tone === "green";
  return (
    <div
      className="group relative flex h-full w-full flex-col justify-between overflow-hidden"
      data-seat-complete={complete ? "true" : undefined}
      onPointerEnter={preWarm}
    >
      <ExecutionCardHeader
        decal={
          <HarnessMark
            agent={agent}
            size={28}
            focused={meta?.focused === true}
          />
        }
        title={
          renaming ? (
            <RenameInput
              initial={rawName}
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <button
              type="button"
              className="nodrag nopan w-full truncate text-left font-mono text-[14px] font-semibold leading-snug"
              style={{ color: INK }}
              title={selected ? "Rename" : "Open terminal"}
              onPointerDown={guardedOpen}
              onClick={guardedOpen}
              onDoubleClick={(event) => {
                if (event.shiftKey) return;
                if (!selected) return;
                event.preventDefault();
                event.stopPropagation();
                onRequestRename();
              }}
            >
              {hero}
            </button>
          )
        }
        subtitle={harnessDisplayName(agent)}
        activity={
          metaCache?.error
            ? { ...activity, label: metaCache.error }
            : activity
        }
      />
      <div
        className="mt-0.5 truncate text-[10px] tabular-nums"
        style={{ color: DIM }}
        title={crumbTitle}
      >
        {crumbs.join(" › ")}
      </div>
      <div className="flex flex-col gap-0.5">
        {serviceBadge ? (
          <div
            className="flex items-center gap-1 truncate text-[10px] tabular-nums"
            style={{
              color:
                service?.health === "live"
                  ? withAlpha(INK, 0.85)
                  : service?.health === "dead"
                    ? HUE.crimson
                    : DIM,
            }}
            title={service?.url ?? serviceBadge}
          >
            <span className="truncate">{serviceBadge}</span>
            {service?.url ? (
              <button
                type="button"
                className="nodrag nopan shrink-0 rounded px-1 text-[9px] uppercase tracking-wide"
                style={{ color: INK, background: withAlpha(INK, 0.08) }}
                title={`Open page · ${service.url}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={openServicePage}
              >
                page
              </button>
            ) : null}
            <button
              type="button"
              className="nodrag nopan shrink-0 rounded px-1 text-[9px] uppercase tracking-wide"
              style={{ color: DIM, background: withAlpha(INK, 0.06) }}
              title="Sync process/port probe"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={syncService}
            >
              sync
            </button>
          </div>
        ) : null}
        <div
          className="line-clamp-1 text-[10px]"
          style={{ color: DIM }}
          title={bottomTitle}
        >
          {cwd ? (
            <>
              <span style={{ color: withAlpha(INK, 0.6) }}>{cwdBase}</span>
              {preview ? (
                <span style={{ color: DIM }}>{` — ${preview}`}</span>
              ) : null}
            </>
          ) : (
            bottomFallback
          )}
        </div>
      </div>
    </div>
  );
}
