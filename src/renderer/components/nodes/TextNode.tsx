import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import type { FlowNode } from "../../lib/convert";
import { getAgentAvatar, getAgentIdentity } from "../../lib/agent";
import { entityReadout } from "../../lib/entity-readout";
import { editText } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { accentColor, INK, DIM, HUE, SOURCE_HUE, withAlpha } from "../../lib/theme";
import { kernel$ } from "../../lib/kernel-state";
import type { WatcherRuntimeState } from "../../lib/kernel-state";
import { NodeShell } from "./NodeShell";

// Re-renders every intervalMs so relative-time copy ("fired 2m ago", "next
// pulse in 12m") stays fresh without a per-second timer — a 30s cadence is
// plenty for minute-grained wording.
function useRelativeNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatAgo(firedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - firedAt) / 60000));
  if (minutes < 1) return "fired just now";
  if (minutes < 60) return `fired ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `fired ${hours}h ago`;
  return `fired ${Math.round(hours / 24)}d ago`;
}

function formatCountdown(nextFire: number, now: number): string {
  const minutes = Math.round((nextFire - now) / 60000);
  if (minutes <= 0) return "pulsing…";
  if (minutes < 60) return `next pulse in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `next pulse in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

const WATCH_STATUS_DOT: Record<WatcherRuntimeState["status"], { readonly color: string; readonly pulse: boolean; readonly glow?: string }> = {
  satisfied: { color: "#5FB98E", pulse: false, glow: "0 0 6px rgba(95,185,142,0.6)" },
  pending: { color: HUE.amber, pulse: true },
  unknown: { color: DIM, pulse: false },
};

// A watcher card: a predicate over live data. Its status is entirely
// DERIVED from kernel$ (never from the document) — the node itself only ever
// carries the definition (ether.watch).
function WatcherCard({ node }: { readonly node: CanvasNode }) {
  const runtime = use$(kernel$.watchers[node.id]) as WatcherRuntimeState | undefined;
  const now = useRelativeNow(30_000);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const status = runtime?.status ?? "unknown";
  const detail = runtime?.detail ?? "watching";
  const dot = WATCH_STATUS_DOT[status];
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center gap-2">
          <span
            className={`size-[6px] shrink-0 rounded-full${dot.pulse ? " vellum-dot--pulse" : ""}`}
            style={{ background: dot.color, boxShadow: dot.glow }}
            title={status}
          />
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>watcher</span>
        </div>
        <div className="mt-1 truncate text-[13px] font-semibold leading-snug" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} title={rawName}>
          {rawName}
        </div>
      </div>
      <div className="text-[10px] leading-snug tabular-nums" style={{ color: DIM }}>
        <div className="truncate" title={detail}>{detail}</div>
        {runtime?.lastFiredAt ? <div className="mt-0.5" style={{ opacity: 0.7 }}>{formatAgo(runtime.lastFiredAt, now)}</div> : null}
      </div>
    </div>
  );
}

// A timer card: a bare pulse on an interval. Countdown reads kernel$.nextFire
// (derived); the interval itself is the document's ether.timer.everyMinutes.
function TimerCard({ node }: { readonly node: CanvasNode }) {
  const nextFire = use$(kernel$.nextFire[node.id]) as number | undefined;
  const now = useRelativeNow(30_000);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const everyMinutes = node.ether?.timer?.everyMinutes;
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>timer</span>
        <div className="mt-1 truncate text-[13px] font-semibold leading-snug" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} title={rawName}>
          {rawName}
        </div>
      </div>
      <div className="text-[10px] leading-snug tabular-nums" style={{ color: DIM }}>
        <div>{nextFire ? formatCountdown(nextFire, now) : "next pulse pending"}</div>
        {everyMinutes ? <div className="mt-0.5" style={{ opacity: 0.7 }}>every {everyMinutes}m</div> : null}
      </div>
    </div>
  );
}

// An entity card (project / agent) is ONE node: its name, one line of live
// stats hydrated from its connectors, and a quiet dot per connector. Never a
// wall of chips, never exploded into child nodes.
function EntityCard({ node, kind }: { readonly node: CanvasNode; readonly kind: string }) {
  const snapshots = use$(state$.snapshots);
  const refreshing = use$(state$.refreshing);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const view = node.ether?.view;
  const { segments, dots } = entityReadout(node.ether?.bindings, snapshots, view);
  const line = segments.join(" · ");
  const eyebrow = kind === "project" && view?.orbit ? `${kind} · ${view.orbit}` : kind;
  const nameHue = node.color ? accentColor(node.color) : INK;
  const isAgent = kind === "agent";
  const hermesKey = isAgent ? node.ether?.bindings?.find((binding) => binding.source === "hermes")?.ref.key : undefined;
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  useEffect(() => {
    if (!hermesKey) return;
    let cancelled = false;
    // getAgentAvatar/getAgentIdentity never reject (lib/agent.ts resolves a
    // miss to null) — the .catch is a floor against a future change to that.
    void getAgentAvatar(hermesKey).then((url) => { if (!cancelled) setAvatarUrl(url); }).catch(() => undefined);
    void getAgentIdentity(hermesKey).then((value) => { if (!cancelled) setIdentity(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hermesKey]);
  const displayName = isAgent && identity?.displayName && identity.displayName !== rawName ? identity.displayName : rawName;
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>{eyebrow}</span>
          <span className="flex items-center gap-1.5">
            {dots.map(({ source, ok }, i) => (
              <span
                key={`${source}-${i}`}
                title={`${source} · ${ok ? "fresh" : "stale"}`}
                className={`size-[5px] rounded-full${refreshing ? " vellum-dot--pulse" : ""}`}
                style={{
                  background: SOURCE_HUE[source] ?? DIM,
                  opacity: ok ? 1 : 0.3,
                  boxShadow: ok ? `0 0 6px ${withAlpha(SOURCE_HUE[source] ?? DIM, 0.6)}` : "none",
                }}
              />
            ))}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 overflow-hidden">
          {isAgent ? (
            <span className="shrink-0 overflow-hidden rounded-full" style={{ width: 20, height: 20 }}>
              {avatarUrl ? <img src={avatarUrl} alt="" className="size-full object-cover" /> : null}
            </span>
          ) : null}
          <span className="truncate text-[14px] font-semibold leading-snug" style={{ color: nameHue, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} title={rawName}>
            {displayName}
          </span>
        </div>
      </div>
      <div className="line-clamp-2 text-[10px] leading-snug tabular-nums" style={{ color: DIM }} title={line}>
        {line || "no live data"}
      </div>
    </div>
  );
}

export function TextNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const text = node.type === "text" ? node.text : "";
  const editNodeId = use$(state$.editNodeId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(text);
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) editText(node.id, draft);
  };

  const lines = text.split("\n");
  const firstIsHeading = lines[0]?.startsWith("#") ?? false;
  const head = firstIsHeading ? lines[0].replace(/^#+\s*/, "") : lines[0];
  const rest = lines.slice(1).join("\n").trim();

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked} onEdit={() => setEditing(true)}>
      {editing ? (
        <textarea
          ref={ref}
          autoFocus
          aria-label="Edit note"
          className="nodrag nowheel h-full w-full resize-none bg-transparent text-[12px] leading-relaxed outline-none"
          style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : node.ether?.entity ? (
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditing(true);
          }}
        >
          {node.ether.entity.kind === "watcher" ? <WatcherCard node={node} />
            : node.ether.entity.kind === "timer" ? <TimerCard node={node} />
              : <EntityCard node={node} kind={node.ether.entity.kind} />}
        </div>
      ) : (
        <button
          type="button"
          className="nopan h-full w-full cursor-text overflow-hidden border-0 bg-transparent p-0 text-left"
          onClick={(event) => {
            if (!selected) return;
            event.stopPropagation();
            setEditing(true);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditing(true);
          }}
        >
          <div
            className={firstIsHeading ? "text-[15px] font-semibold leading-snug" : "text-[12px] leading-snug"}
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {head}
          </div>
          {rest ? (
            <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: DIM }}>
              {rest}
            </div>
          ) : null}
        </button>
      )}
    </NodeShell>
  );
}
