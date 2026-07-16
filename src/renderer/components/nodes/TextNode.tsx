import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import type { FlowNode } from "../../lib/convert";
import { getAgentAvatar, getAgentIdentity } from "../../lib/agent";
import { boothPendingReview, entityReadout } from "../../lib/entity-readout";
import { editText, setNodeTasks } from "../../lib/mutations";
import { NoteMarkdown } from "../../lib/note-markdown";
import { state$ } from "../../lib/state";
import { chatActivity, timerActivity, watcherActivity } from "../../lib/activity";
import { chatState$, initialAgentChatState } from "../../lib/chat-state";
import { accentColor, INK, DIM, HUE, SOURCE_HUE, withAlpha } from "../../lib/theme";
import { kernel$ } from "../../lib/kernel-view";
import type { WatcherRuntimeState } from "../../lib/kernel-view";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { HerdrCard } from "../herdr/HerdrCard";
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
  // Due state is ActivityMark wave only — no "pulsing…" label.
  if (minutes <= 0) return "now";
  if (minutes < 60) return `next pulse in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `next pulse in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

// A watcher card: a predicate over live data. Its status is entirely
// DERIVED from kernel$ (never from the document) — the node itself only ever
// carries the definition (ether.watch).
function WatcherCard({ node }: { readonly node: CanvasNode }) {
  const runtime = use$(kernel$.watchers[node.id]) as WatcherRuntimeState | undefined;
  const now = useRelativeNow(30_000);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const status = runtime?.status ?? "unknown";
  const detail = runtime?.detail ?? "watching";
  const activity = watcherActivity(status);
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center gap-2">
          <ActivityMarkFromSpec spec={activity} />
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
  const activity = timerActivity({ nextFire, now });
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center gap-2">
          <ActivityMarkFromSpec spec={activity} />
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>timer</span>
        </div>
        <div className="mt-1 truncate text-[13px] font-semibold leading-snug" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} title={rawName}>
          {rawName}
        </div>
      </div>
      <div className="text-[10px] leading-snug tabular-nums" style={{ color: DIM }}>
        {/* Countdown numbers are content, not status labels. */}
        <div>{nextFire ? formatCountdown(nextFire, now) : "—"}</div>
        {everyMinutes ? <div className="mt-0.5" style={{ opacity: 0.7 }}>every {everyMinutes}m</div> : null}
      </div>
    </div>
  );
}

// Local checklist card. Toggle done on the document; blocks only when edged.
function TasksCard({ node }: { readonly node: CanvasNode }) {
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const items = node.ether?.tasks?.items ?? [];
  const open = items.filter((item) => !item.done).length;
  const toggle = (itemId: string) => {
    const next = items.map((item) =>
      item.id === itemId ? { ...item, done: !item.done } : item,
    );
    setNodeTasks(node.id, next);
  };
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>tasks</span>
        <span className="text-[9px] tabular-nums" style={{ color: DIM }}>
          {items.length - open}/{items.length}
        </span>
      </div>
      <div
        className="mt-1 truncate text-[13px] font-semibold leading-snug"
        style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
        title={rawName}
      >
        {rawName}
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <button
            key={item.id}
            type="button"
            className="nodrag nopan flex items-center gap-1.5 truncate text-left text-[10px] leading-snug"
            style={{ color: item.done ? DIM : INK, opacity: item.done ? 0.65 : 1 }}
            onClick={(event) => {
              event.stopPropagation();
              toggle(item.id);
            }}
          >
            <span aria-hidden style={{ color: item.done ? "#5FB98E" : HUE.amber }}>
              {item.done ? "☑" : "☐"}
            </span>
            <span className="truncate" style={{ textDecoration: item.done ? "line-through" : "none" }}>
              {item.text || item.id}
            </span>
          </button>
        ))}
        {items.length > 4 ? (
          <div className="text-[9px]" style={{ color: DIM }}>
            +{items.length - 4} more
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Live chat activity for a hermes agent node — separate component so hooks stay unconditional. */
function AgentActivityMark({ agentKey }: { readonly agentKey: string }) {
  const raw = use$(chatState$[agentKey]);
  const state = raw ?? initialAgentChatState();
  const tools = state.transcript
    .filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool")
    .map((item) => ({ status: item.status }));
  const activity = chatActivity({
    status: state.status,
    pendingPermission: Boolean(state.pendingPermission),
    tools,
    sending: state.turnBusy,
  });
  return <ActivityMarkFromSpec spec={activity} />;
}

// An entity card (project / agent) is ONE node: its name, one line of live
// stats hydrated from its connectors, and a quiet dot per connector. Never a
// wall of chips, never exploded into child nodes.
function EntityCard({ node, kind }: { readonly node: CanvasNode; readonly kind: string }) {
  const snapshots = use$(state$.snapshots);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const view = node.ether?.view;
  const { segments, dots } = entityReadout(node.ether?.entity, snapshots, view);
  const line = segments.join(" · ");
  // Booth attention decal: drafts owed a human verdict. Exists only above
  // zero — a quiet card carries no badge, per the exception-only contract.
  const pendingReview = boothPendingReview(node.ether?.entity, snapshots);
  const eyebrow = kind === "project" && view?.orbit ? `${kind} · ${view.orbit}` : kind;
  const nameHue = node.color ? accentColor(node.color) : INK;
  const isAgent = kind === "agent";
  const hermesKey = isAgent ? node.ether?.entity?.name : undefined;
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
            {pendingReview > 0 ? (
              <span
                title={`${pendingReview} booth draft${pendingReview === 1 ? "" : "s"} awaiting review`}
                className="rounded-full border px-1.5 py-px text-[8px] font-semibold tabular-nums leading-none tracking-[.06em]"
                style={{
                  color: SOURCE_HUE.booth,
                  borderColor: withAlpha(SOURCE_HUE.booth, 0.45),
                  background: withAlpha(SOURCE_HUE.booth, 0.12),
                  boxShadow: `0 0 8px ${withAlpha(SOURCE_HUE.booth, 0.35)}`,
                }}
              >
                {pendingReview} to review
              </span>
            ) : null}
            {hermesKey ? <AgentActivityMark agentKey={hermesKey} /> : null}
            {dots.map(({ source, ok }, i) => (
              <span
                key={`${source}-${i}`}
                title={`${source} · ${ok ? "fresh" : "stale"}`}
                className="size-[5px] rounded-full"
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

// Freeform note body: one ink tone, one typeface — markdown is structure,
// not a shade ladder. Entity cards keep their own compact presentation.
const NOTE_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const NOTE_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function NoteEditModal({
  draft,
  onChange,
  onCommit,
  onDiscard,
}: {
  readonly draft: string;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly onDiscard: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    // Place caret at end for writing continuation rather than select-all.
    const el = textareaRef.current;
    if (el) {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDiscard();
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onCommit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCommit, onDiscard]);

  return createPortal(
    <div
      ref={overlayRef}
      className="vellum-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === overlayRef.current) onCommit();
      }}
    >
      <div className="vellum-modal note-edit-modal nowheel" role="dialog" aria-modal="true" aria-label="Edit note">
        <div className="note-edit-modal__chrome">
          <span className="note-edit-modal__eyebrow">note · markdown</span>
          <div className="note-edit-modal__actions">
            <button type="button" className="note-edit-modal__done" onClick={onCommit}>
              done
            </button>
            <button type="button" className="vellum-modal__close" aria-label="Close without saving" onClick={onDiscard}>
              <X size={13} />
            </button>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          className="note-edit-modal__textarea nodrag nowheel"
          aria-label="Note markdown"
          spellCheck
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          placeholder={"# heading\n\n- list item\n\n**bold** and `code`"}
        />
        <div className="note-edit-modal__hint">⌘↵ save · esc discard</div>
      </div>
    </div>,
    document.body,
  );
}

export function TextNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const text = node.type === "text" ? node.text : "";
  const isFreeNote = !node.ether?.entity;
  const editNodeId = use$(state$.editNodeId);
  const [editing, setEditing] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && !maximized) {
      setDraft(text);
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, maximized]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setDraft(text);
    if (isFreeNote) setMaximized(true);
    else setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id, isFreeNote, text]);

  const commit = () => {
    setEditing(false);
    setMaximized(false);
    if (draft !== text) editText(node.id, draft);
  };

  const discard = () => {
    setEditing(false);
    setMaximized(false);
    setDraft(text);
  };

  const openInline = () => {
    setDraft(text);
    setMaximized(false);
    setEditing(true);
  };

  const openMaximized = () => {
    setDraft(text);
    setEditing(false);
    setMaximized(true);
  };

  return (
    <NodeShell
      node={node}
      selected={selected}
      blocked={data.blocked}
      onEdit={openInline}
      onMaximize={isFreeNote ? openMaximized : undefined}
    >
      {maximized ? (
        <NoteEditModal
          draft={draft}
          onChange={setDraft}
          onCommit={commit}
          onDiscard={discard}
        />
      ) : null}
      {editing && !maximized ? (
        <textarea
          ref={ref}
          autoFocus
          aria-label="Edit note"
          className="note-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent outline-none"
          style={{ color: INK, fontFamily: NOTE_MONO }}
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
              discard();
            }
          }}
        />
      ) : node.ether?.entity ? (
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openInline();
          }}
        >
          {node.ether.entity.kind === "watcher" ? <WatcherCard node={node} />
            : node.ether.entity.kind === "timer" ? <TimerCard node={node} />
              : node.ether.entity.kind === "task" ? <TasksCard node={node} />
                : node.ether.entity.kind === "herdr" ? <HerdrCard node={node} />
                : <EntityCard node={node} kind={node.ether.entity.kind} />}
        </div>
      ) : (
        <button
          type="button"
          className="note-surface nopan h-full w-full cursor-text overflow-hidden border-0 bg-transparent p-0 text-left items-stretch justify-start"
          style={{ fontFamily: NOTE_FONT, color: INK }}
          onClick={(event) => {
            if (!selected) return;
            event.stopPropagation();
            openInline();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openInline();
          }}
        >
          <NoteMarkdown source={text} />
        </button>
      )}
    </NodeShell>
  );
}
