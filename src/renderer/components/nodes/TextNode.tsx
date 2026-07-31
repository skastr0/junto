import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import type { FlowNode } from "../../lib/convert";
import { getAgentAvatar, getAgentIdentity } from "../../lib/agent";
import { registerCanvasDraftCommit } from "../../lib/canvas-editor-flush";
import { editText } from "../../lib/mutations";
import { NoteMarkdown } from "../../lib/note-markdown";
import { state$ } from "../../lib/state";
import { findEntity } from "@shared/entities";
import { workRoleOf } from "@shared/attention";
import {
  chatActivity,
  terminalActivity,
  timerActivity,
  watcherActivity,
} from "../../lib/activity";
import { chatCoarse$ } from "../../lib/chat-state";
import { accentColor, HUE, INK, DIM } from "../../lib/theme";
import { kernel$ } from "../../lib/kernel-view";
import type { WatcherRuntimeState } from "../../lib/kernel-view";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { resolveTerminalBinding } from "@shared/terminal";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { openHerdrTerminal } from "../../lib/herdr-state";
import { openTerminal } from "../../lib/terminal-actions";
import { openAgentChatSurface } from "../../lib/dock-state";
import { consumeWorkDetailOpen, workDetailOpen$ } from "../../lib/work-detail-open";
import { terminal$ } from "../../lib/terminal-state";
import { getVellumApi } from "../../lib/vellum-api";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { HerdrCard } from "../herdr/HerdrCard";
import { HarnessMark } from "../herdr/HarnessMark";
import { TerminalCard } from "../terminal/TerminalCard";
import { TerminalToolbarActions } from "../terminal/TerminalToolbarActions";
import { HerdrToolbarActions } from "../herdr/HerdrToolbarActions";
import { AgentChatToolbarActions } from "../chat/AgentChatToolbarActions";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, IconButton } from "../ui";
import {
  ArtifactsCard,
  ArtifactsDetail,
  BoardCard,
  BoardDetail,
  RequestsCard,
  RequestsDetail,
  TasksCard,
  TasksDetail,
} from "../work/WorkSurfaces";
import { ClaimedTaskStrip } from "./ClaimedTaskStrip";
import { ExecutionCardHeader } from "./ExecutionCardHeader";
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
  if (minutes < 60) return `next run in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `next run in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

// Gauge / relay card: status is DERIVED from kernel$ (never the document).
function WatcherCard({
  node,
  label,
}: {
  readonly node: CanvasNode;
  readonly label: "gauge" | "relay";
}) {
  const runtime = use$(kernel$.watchers[node.id]) as
    WatcherRuntimeState | undefined;
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
          <span
            className="text-[8px] uppercase tracking-[0.18em]"
            style={{ color: "#68604a" }}
          >
            {label}
          </span>
        </div>
        <div
          className="mt-1 truncate font-mono text-[13px] font-semibold leading-snug"
          style={{ color: INK }}
          title={rawName}
        >
          {rawName}
        </div>
      </div>
      <div
        className="text-[10px] leading-snug tabular-nums"
        style={{ color: DIM }}
      >
        <div className="truncate" title={detail}>
          {detail}
        </div>
        {runtime?.lastFiredAt ? (
          <div className="mt-0.5" style={{ opacity: 0.7 }}>
            {formatAgo(runtime.lastFiredAt, now)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Cron card: countdown from kernel$.nextFire; interval from ether.timer.
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
          <span
            className="text-[8px] uppercase tracking-[0.18em]"
            style={{ color: "#68604a" }}
          >
            cron
          </span>
        </div>
        <div
          className="mt-1 truncate font-mono text-[13px] font-semibold leading-snug"
          style={{ color: INK }}
          title={rawName}
        >
          {rawName}
        </div>
      </div>
      <div
        className="text-[10px] leading-snug tabular-nums"
        style={{ color: DIM }}
      >
        {/* Countdown numbers are content, not status labels. */}
        <div>{nextFire ? formatCountdown(nextFire, now) : "—"}</div>
        {everyMinutes ? (
          <div className="mt-0.5" style={{ opacity: 0.7 }}>
            every {everyMinutes}m
          </div>
        ) : null}
      </div>
    </div>
  );
}

// An entity card (project / agent) is ONE node: its name, one line of live
// stats hydrated from its connectors, and a quiet dot per connector. Never a
// wall of chips, never exploded into child nodes.
//
// Subscribes to this agent's hermes entity only (primitive-derived selectors)
// so unrelated snapshot churn does not re-render every agent card.
function EntityCard({
  node,
  kind,
  graphBlocked = false,
}: {
  readonly node: CanvasNode;
  readonly kind: string;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
}) {
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const nameHue = node.color ? accentColor(node.color) : INK;
  const workRole = workRoleOf(node);
  const hermesKey = kind === "agent" ? node.ether?.entity?.name : undefined;
  const managedHarness =
    kind === "agent" && typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const terminalBinding = resolveTerminalBinding(node);
  const bindingId =
    terminalBinding?.kind === "native" ? terminalBinding.bindingId : undefined;
  const hostId =
    terminalBinding?.kind === "native" ? terminalBinding.hostId : undefined;
  const seatEvent = use$(
    agentSeat$.byBindingId[bindingId ?? "__vellum-entity-card-no-binding__"],
  );
  const session = use$(
    terminal$.sessionByBindingId[
      bindingId ?? "__vellum-entity-card-no-binding__"
    ],
  );
  const coarse = use$(
    chatCoarse$[hermesKey ?? "__vellum-entity-card-no-agent__"],
  );
  const line = use$(() => {
    if (!hermesKey) return "";
    const hermes = findEntity(state$.snapshots.get(), "hermes", hermesKey);
    if (!hermes) return "";
    const segments: string[] = [];
    const status = hermes.stats.status;
    if (typeof status === "string" && status) segments.push(status);
    const model = hermes.stats.model;
    if (typeof model === "string" && model) segments.push(model);
    return segments.join(" · ");
  });
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  useEffect(() => {
    if (!hermesKey) return;
    let cancelled = false;
    void getAgentAvatar(hermesKey)
      .then((url) => {
        if (!cancelled) setAvatarUrl(url);
      })
      .catch(() => undefined);
    void getAgentIdentity(hermesKey)
      .then((value) => {
        if (!cancelled) setIdentity(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hermesKey]);
  // Hydrate session cache so pre-ownership failures (cli-missing) paint on the card.
  useEffect(() => {
    if (!bindingId) return;
    const refresh = () =>
      getVellumApi()
        ?.terminalGet?.(bindingId, hostId)
        .then((next) => {
          terminal$.sessionByBindingId[bindingId].set(next);
        })
        .catch(() => undefined);
    void refresh();
    const off = getVellumApi()?.onTerminalEvent?.((raw) => {
      if ((raw as { bindingId?: string }).bindingId === bindingId) {
        void refresh();
      }
    });
    return () => off?.();
  }, [bindingId, hostId]);
  const displayName =
    hermesKey && identity?.displayName && identity.displayName !== rawName
      ? identity.displayName
      : rawName;
  const managed = managedHarness !== undefined && isHarnessId(managedHarness);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const activity = managed
    ? terminalActivity({
        seatState: seatEvent?.state,
        running: session?.status === "running",
        starting: session?.status === "starting",
        graphBlocked,
        exitReason,
        exitMessage,
      })
    : graphBlocked
      ? {
          mode: "wave" as const,
          tone: "crimson" as const,
          pattern: "arrow-up" as const,
          label: "blocked",
        }
      : chatActivity({
          status: coarse?.status ?? "idle",
          pendingPermission: Boolean(coarse?.pendingPermissionId),
          tools: coarse?.hasBusyTools ? [{ status: "in_progress" as const }] : [],
          sending: coarse?.turnBusy ?? false,
        });
  // Host is deliberately absent: which machine a seat sits on is not what the
  // operator reads an agent node for, and it crowded out the claimed task.
  // Spawn failures surface as a context line so the mark + copy both land.
  const context = [
    workRole,
    managed && exitReason && exitMessage ? exitMessage : undefined,
  ].filter((value): value is string => Boolean(value));

  return (
    <div
      className="flex h-full w-full flex-col justify-between overflow-hidden"
      data-exit-reason={managed ? exitReason : undefined}
    >
      <div>
        <ExecutionCardHeader
          decal={
            managed ? (
              <HarnessMark agent={managedHarness} size={28} />
            ) : avatarUrl ? (
              <span className="size-7 shrink-0 overflow-hidden rounded-md">
                <img
                  src={avatarUrl}
                  alt=""
                  className="size-full object-cover"
                />
              </span>
            ) : (
              <HarnessMark size={28} />
            )
          }
          title={
            <div
              className="truncate font-mono text-[14px] font-semibold leading-snug"
              style={{ color: nameHue }}
              title={rawName}
            >
              {displayName}
            </div>
          }
          activity={
            seatEvent?.state === "attention" && seatEvent.reason
              ? { ...activity, label: seatEvent.reason }
              : activity
          }
        />
        {context.length > 0 ? (
          <div
            className="mt-1 truncate text-[10px] tabular-nums"
            style={{
              color: managed && exitReason ? HUE.amber : DIM,
            }}
            title={
              managed && exitMessage
                ? exitMessage
                : workRole
                  ? `work role: ${workRole}`
                  : undefined
            }
          >
            {context.join(" › ")}
          </div>
        ) : null}
      </div>
      {!managed ? (
        <div
          className="line-clamp-2 text-[10px] leading-snug tabular-nums"
          style={{ color: DIM }}
          title={line}
        >
          {line || "no live data"}
        </div>
      ) : null}
      {kind === "agent" ? <ClaimedTaskStrip node={node} /> : null}
    </div>
  );
}

// Freeform note body: instrument mono for body; condensed display for heads
// (CSS). Markdown is structure only — no wiki/chips/shorthand leak.

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useLayoutEffect(
    () => registerCanvasDraftCommit(() => commitRef.current()),
    [],
  );

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

  // House FocusSurface owns portal/backdrop/enter-animation/session size.
  // Semantics preserved: backdrop click SAVES (onClose=onCommit), Escape
  // discards (own keydown; FocusSurface Escape stays off).
  return (
    <FocusSurface
      measure="document"
      height="resizable"
      layer="detail"
      label="Edit note"
      onClose={onCommit}
      closeOnEscape={false}
    >
      <div className="note-edit-modal nowheel">
        <div className="note-edit-modal__chrome">
          <Eyebrow tone="faint" size="xs">
            note · markdown
          </Eyebrow>
          <div className="note-edit-modal__actions">
            <Button size="xs" variant="chrome" onClick={onCommit}>
              done
            </Button>
            <IconButton
              size="sm"
              aria-label="Close without saving"
              title="discard"
              onClick={onDiscard}
            >
              <X size={13} />
            </IconButton>
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
    </FocusSurface>
  );
}

export function TextNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const text = node.type === "text" ? node.text : "";
  const isFreeNote = !node.ether?.entity;
  const isHerdr = node.ether?.entity?.kind === "herdr";
  const isTerminal = node.ether?.entity?.kind === "terminal";
  const isAgent = node.ether?.entity?.kind === "agent";
  const managedTerminal =
    Boolean(node.ether?.terminal?.bindingId) && (isTerminal || isAgent);
  // Boolean selector: only this node re-renders when edit intent targets it.
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [workDetail, setWorkDetail] = useState(false);
  const [workDetailItemId, setWorkDetailItemId] = useState<string | undefined>();
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const entityKind = node.ether?.entity?.kind;
  const isWorkSurface =
    entityKind === "task" ||
    entityKind === "requests" ||
    entityKind === "artifacts" ||
    entityKind === "board";

  useEffect(() => {
    if (editing && !maximized) {
      setDraft(text);
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, maximized]);

  useEffect(() => {
    if (!isEditTarget) return;
    setDraft(text);
    if (isFreeNote) setMaximized(true);
    else if (isHerdr) setRenaming(true);
    else setEditing(true);
    state$.editNodeId.set("");
  }, [isEditTarget, node.id, isFreeNote, isHerdr, text]);

  // Cross-surface open trigger (RTS bars / jump-to-cause): mirrors editNodeId —
  // consume the target (+ optional item id), open the work-plane detail, clear.
  const isWorkDetailTarget = use$(
    () => workDetailOpen$.nodeId.get() === node.id,
  );
  useEffect(() => {
    if (!isWorkDetailTarget) return;
    const consumed = consumeWorkDetailOpen(node.id);
    if (!isWorkSurface || !consumed) return;
    setWorkDetailItemId(consumed.itemId || undefined);
    setWorkDetail(true);
  }, [isWorkDetailTarget, isWorkSurface, node.id]);

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

  const herdrBinding = isHerdr ? node.ether?.herdr : undefined;
  const title = text.split("\n")[0] ?? "herdr";
  const openHerdr = () => {
    if (herdrBinding) openHerdrTerminal(node.id, herdrBinding, title);
  };

  return (
    <NodeShell
      node={node}
      selected={selected}
      blocked={data.blocked}
      onEdit={
        isHerdr
          ? () => setRenaming(true)
          : managedTerminal
            ? undefined
            : openInline
      }
      onMaximize={isFreeNote ? openMaximized : undefined}
      inlineEdit={!isHerdr && !managedTerminal}
      toolbarExtras={
        isHerdr ? (
          <HerdrToolbarActions node={node} />
        ) : managedTerminal ? (
          <TerminalToolbarActions node={node} />
        ) : isAgent && !ACP_CHAT_SURFACE_HIDDEN ? (
          <AgentChatToolbarActions node={node} />
        ) : undefined
      }
    >
      {maximized ? (
        <NoteEditModal
          draft={draft}
          onChange={setDraft}
          onCommit={commit}
          onDiscard={discard}
        />
      ) : null}
      {workDetail && entityKind === "task" ? (
        <TasksDetail
          node={node}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && entityKind === "requests" ? (
        <RequestsDetail
          node={node}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && entityKind === "board" ? (
        <BoardDetail node={node} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && entityKind === "artifacts" ? (
        <ArtifactsDetail
          node={node}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {editing &&
      !maximized &&
      !isHerdr &&
      !managedTerminal &&
      !isWorkSurface ? (
        <textarea
          ref={ref}
          autoFocus
          aria-label="Edit note"
          className="note-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent font-mono outline-none"
          style={{ color: INK }}
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
            // herdr / terminal / managed agent: double-click opens the live surface.
            // ACP chat is hard-hidden — agent seats open the managed terminal.
            if (isHerdr) {
              openHerdr();
              return;
            }
            if (managedTerminal) {
              void openTerminal(node);
              return;
            }
            if (isAgent) {
              if (!ACP_CHAT_SURFACE_HIDDEN) openAgentChatSurface(node);
              return;
            }
            if (isWorkSurface) {
              setWorkDetail(true);
              return;
            }
            openInline();
          }}
        >
          {entityKind === "watcher" ? (
            <WatcherCard node={node} label="gauge" />
          ) : entityKind === "relay" ? (
            <WatcherCard node={node} label="relay" />
          ) : entityKind === "timer" || entityKind === "cron" ? (
            <TimerCard node={node} />
          ) : entityKind === "task" ? (
            <TasksCard node={node} />
          ) : entityKind === "requests" ? (
            <RequestsCard node={node} />
          ) : entityKind === "artifacts" ? (
            <ArtifactsCard node={node} />
          ) : entityKind === "board" ? (
            <BoardCard node={node} />
          ) : entityKind === "herdr" ? (
            <HerdrCard
              node={node}
              selected={selected}
              renaming={renaming}
              onRequestRename={() => setRenaming(true)}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "terminal" ? (
            <TerminalCard node={node} graphBlocked={data.blocked} />
          ) : entityKind === "agent" ? (
            <EntityCard node={node} kind="agent" graphBlocked={data.blocked} />
          ) : (
            <NoteMarkdown source={text} />
          )}
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="note-surface nopan h-full w-full cursor-text overflow-hidden border-0 bg-transparent p-0 text-left font-mono items-stretch justify-start"
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
          onKeyDown={(event) => {
            if (!selected) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              openInline();
            }
          }}
        >
          <NoteMarkdown source={text} />
        </div>
      )}
    </NodeShell>
  );
}
