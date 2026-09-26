import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { Gauge, Radio, Settings2, Timer } from "lucide-react";

import type { CanvasNode } from "@shared/canvas";
import {
  describeCronExpression,
  expressionFromEveryMinutes,
  isValidCronExpression,
} from "@shared/cron-expression";
import type { FlowNode } from "../../lib/convert";
import { CronScheduleSurface } from "./CronScheduleSurface";
import { useSeatAwarenessOn } from "../../lib/experimental-features";
import { editText } from "../../lib/mutations";
import { NoteMarkdown } from "../../lib/note-markdown";
import { isGitNode, isLabelNode } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { timerActivity, watcherActivity } from "../../lib/activity";
import {
  cardMark,
  seatFactsForNode,
} from "../../lib/seat-projections";
import { useNodeAttentionReasons } from "../../lib/occupancy-feed";
import { accentColor, HUE, INK, DIM } from "../../lib/theme";
import { kernel$ } from "../../lib/kernel-view";
import type { WatcherRuntimeState } from "../../lib/kernel-view";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { resolveTerminalBinding } from "@shared/terminal";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { productNodeKindEnabled, TASKS_ENABLED } from "@shared/features";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { consumeWorkDetailOpen, workDetailOpen$ } from "../../lib/work-detail-open";
import { onTerminalEvent } from "../../lib/terminal-events";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { terminal$ } from "../../lib/terminal-state";
import { openNoteSurface } from "../../lib/dock-state";
import { getJuntoApi } from "../../lib/junto-api";
import { HarnessMark } from "../HarnessMark";
import { OverseerMark } from "../OverseerMark";
import { isOverseerSeat } from "../../lib/overseer-set";
import { SeatAwarenessHoverForNode } from "../terminal/SeatAwarenessHoverForNode";
import { SeatCollaborationBlock } from "../terminal/SeatCollaborationBlock";
import { TerminalCard } from "../terminal/TerminalCard";
import {
  closeSeatCollaboration,
  openSeatCollaboration,
  seatCollaborationUi$,
} from "../../lib/seat-collaboration";
import { TerminalToolbarActions } from "../terminal/TerminalToolbarActions";
import { AgentChatToolbarActions } from "../chat/AgentChatToolbarActions";
import { FirstLineRenameInput } from "./FirstLineRenameInput";
import { claimFocus } from "../../lib/focus-ownership";
import { IconButton } from "../ui";
import { AgentSeat } from "./AgentSeat";
import { ExecutionCardHeader } from "./ExecutionCardHeader";
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
import { PadCard } from "../pad/PadCard";
import { SheetCard } from "../sheet/SheetCard";
import { SheetDetail } from "../sheet/SheetDetail";
import { PadDetail } from "../pad/PadDetail";
import { GitCard } from "../git/GitCard";
import { GitDetail } from "../git/GitDetail";
import { TaskToolbarActions } from "../work/TaskToolbarActions";
import { ClaimedTaskStrip } from "./ClaimedTaskStrip";

import { NodeShell } from "./NodeShell";

function CronScheduleToolbarAction({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <IconButton
      className="nodrag nopan"
      aria-label="Schedule settings"
      title="Schedule settings"
      data-testid="node-toolbar-cron-settings"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
    >
      <Settings2 size={14} />
    </IconButton>
  );
}

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

/** Last effect run — product wording, not kernel debug. */
function formatLastRun(firedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - firedAt) / 60000));
  if (minutes < 1) return "Last ran just now";
  if (minutes < 60) return `Last ran ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last ran ${hours}h ago`;
  return `Last ran ${Math.round(hours / 24)}d ago`;
}

function formatCountdown(nextFire: number, now: number): string {
  const minutes = Math.round((nextFire - now) / 60000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

const cronExpressionOf = (
  timer: { readonly expression?: string; readonly everyMinutes?: number } | undefined,
): string => {
  const expr = timer?.expression?.trim();
  if (expr && isValidCronExpression(expr)) return expr.replace(/\s+/g, " ");
  if (typeof timer?.everyMinutes === "number" && timer.everyMinutes > 0) {
    return expressionFromEveryMinutes(timer.everyMinutes);
  }
  return "*/30 * * * *";
};

/** Kind decal — same 28px amber tile as terminal / seats. */
function SchedulerDecal({
  kind,
}: {
  readonly kind: "cron" | "gauge" | "relay";
}) {
  const Icon = kind === "cron" ? Timer : kind === "gauge" ? Gauge : Radio;
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
      <Icon size={15} />
    </div>
  );
}

// Gauge / relay: kernel status only. Idle mark is silent.
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
  const title = rawName || label;
  const status = runtime?.status ?? "unknown";
  const detail = runtime?.detail ?? "no watch yet";
  const activity = watcherActivity(status);
  // Product: one line = what we're waiting on. Optional second line = last run.
  // Never mid-dots, never wire jargon jammed onto fire history.
  const subtitle = runtime?.lastFiredAt ? (
    <span className="flex flex-col gap-0.5">
      <span className="truncate">{detail}</span>
      <span className="truncate opacity-80">
        {formatLastRun(runtime.lastFiredAt, now)}
      </span>
    </span>
  ) : (
    detail
  );
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <ExecutionCardHeader
        decal={<SchedulerDecal kind={label} />}
        title={
          <div
            className="truncate font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title={title}
          >
            {title}
          </div>
        }
        subtitle={subtitle}
        activity={activity}
      />
    </div>
  );
}

// Cron: countdown + expression glance; schedule via double-click modal.
function TimerCard({ node }: { readonly node: CanvasNode }) {
  const nextFire = use$(kernel$.nextFire[node.id]) as number | undefined;
  const now = useRelativeNow(30_000);
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const title = rawName || "cron";
  const expression = cronExpressionOf(node.ether?.timer);
  const activity = timerActivity({ nextFire, now });
  const countdown = nextFire ? formatCountdown(nextFire, now) : "—";
  const scheduleLine = describeCronExpression(expression);
  const subtitle = (
    <span className="flex flex-col gap-0.5">
      <span className="tabular-nums">{countdown}</span>
      <span className="truncate font-mono" style={{ opacity: 0.85 }} title={expression}>
        {scheduleLine}
      </span>
    </span>
  );
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <ExecutionCardHeader
        decal={<SchedulerDecal kind="cron" />}
        title={
          <div
            className="truncate font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title={title}
          >
            {title}
          </div>
        }
        subtitle={subtitle}
        activity={activity}
      />
    </div>
  );
}

// Actor seat card — document label + harness mark + terminal seat activity.
// No hermes corpus join, matrix identity, or profile avatar IPC.
function EntityCard({
  node,
  kind,
  graphBlocked = false,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly kind: string;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
}) {
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const nameHue = node.color ? accentColor(node.color) : INK;
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
    agentSeat$.byBindingId[bindingId ?? "__junto-entity-card-no-binding__"],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[
      bindingId ?? "__junto-entity-card-no-binding__"
    ],
  );
  const session = use$(
    terminal$.sessionByBindingId[
      bindingId ?? "__junto-entity-card-no-binding__"
    ],
  );
  // Hydrate session cache so pre-ownership failures (cli-missing) paint on the card.
  useEffect(() => {
    if (!bindingId) return;
    const refresh = () =>
      getJuntoApi()
        ?.terminalGet?.(bindingId, hostId)
        .then((next) => {
          const prev = terminal$.sessionByBindingId[bindingId].peek();
          if (sessionChromeUnchanged(prev, next)) return;
          terminal$.sessionByBindingId[bindingId].set(next);
        })
        .catch(() => undefined);
    void refresh();
    // Routed by binding — the manual bindingId compare is what made every
    // agent card pay for every other terminal's output. The session/exit cut
    // below is a separate predicate and stays.
    const off = onTerminalEvent(
      (raw) => {
        if (!shouldRefreshSessionFromTerminalEvent(raw)) return;
        void refresh();
      },
      { bindingId },
    );
    return off;
  }, [bindingId, hostId]);
  const managed = managedHarness !== undefined && isHarnessId(managedHarness);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const attentionReasons = useNodeAttentionReasons(node);
  const activity = cardMark(
    seatFactsForNode({
      nodeId: node.id,
      seatEvent,
      session,
      needsLook: needsLook === true,
      graphBlocked,
      flags: node.ether?.flags,
      attentionReasons,
      managedSeat: managed,
    }),
  );
  // Host is deliberately absent: which machine a seat sits on is not what the
  // operator reads an agent node for, and it crowded out the claimed task.
  // Spawn failures surface as a context line so the mark + copy both land.
  const context = managed && exitReason && exitMessage ? exitMessage : undefined;
  const commitRename = (firstLine: string) => {
    if (node.type !== "text") return;
    const rest = node.text.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${firstLine}\n${rest}` : firstLine);
  };

  const complete = activity.mode === "pulse" && activity.tone === "green";
  const overseer = kind === "agent" && isOverseerSeat(node);
  const nameTitle =
    renaming && onRenameDone ? (
      <FirstLineRenameInput
        initial={rawName}
        ariaLabel="Rename agent node"
        onCommit={commitRename}
        onDone={onRenameDone}
      />
    ) : (
      <div
        className={`truncate font-mono ${kind === "agent" ? "text-[13px]" : "text-[14px]"} font-semibold leading-snug`}
        style={{ color: nameHue }}
        title={rawName}
      >
        {rawName}
      </div>
    );
  const seatActivity =
    seatEvent?.state === "attention" && seatEvent.reason
      ? { ...activity, label: seatEvent.reason }
      : activity;
  // An agent is a seat, not a card: its ring is the status instrument.
  if (kind === "agent") {
    return (
      <div
        className="factory-agent-card relative flex h-full w-full flex-col justify-center overflow-hidden"
        data-exit-reason={managed ? exitReason : undefined}
        data-seat-complete={complete ? "true" : undefined}
        data-overseer={overseer ? "true" : undefined}
      >
        <AgentSeat
          node={node}
          activity={seatActivity}
          title={nameTitle}
          harness={managed ? managedHarness : undefined}
          context={context}
        >
          {overseer ? (
            <div className="mt-1">
              <OverseerMark size="card" />
            </div>
          ) : null}
          {TASKS_ENABLED ? <ClaimedTaskStrip node={node} /> : null}
        </AgentSeat>
      </div>
    );
  }
  return (
    <div
      className="factory-agent-card relative flex h-full w-full flex-col justify-between overflow-hidden"
      data-exit-reason={managed ? exitReason : undefined}
      data-seat-complete={complete ? "true" : undefined}
      data-overseer={overseer ? "true" : undefined}
    >
      <ExecutionCardHeader
        decal={<HarnessMark agent={managed ? managedHarness : undefined} size={28} />}
        title={nameTitle}
        activity={seatActivity}
      />
      {context !== undefined && context.length > 0 ? (
        <div
          className="mt-1 truncate text-[10px] tabular-nums"
          style={{
            color: managed && exitReason ? HUE.amber : DIM,
          }}
          title={context}
        >
          {context}
        </div>
      ) : null}
    </div>
  );
}

// Freeform note body: instrument mono for body; condensed display for heads
// (CSS). Markdown is structure only — no wiki/chips/shorthand leak.

export function TextNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const text = node.type === "text" ? node.text : "";
  const isLabel = isLabelNode(node);
  const isFreeNote = !node.ether?.entity;
  const isTerminal = node.ether?.entity?.kind === "terminal";
  const isAgent = node.ether?.entity?.kind === "agent";
  const managedTerminal =
    Boolean(node.ether?.terminal?.bindingId) && (isTerminal || isAgent);
  // Boolean selector: only this node re-renders when edit intent targets it.
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);

  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [workDetail, setWorkDetail] = useState(false);
  const [workDetailItemId, setWorkDetailItemId] = useState<string | undefined>();
  const [cronScheduleOpen, setCronScheduleOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const entityKind = node.ether?.entity?.kind;
  const isWorkSurface =
    entityKind === "task" ||
    entityKind === "requests" ||
    entityKind === "artifacts" ||
    entityKind === "board" ||
    entityKind === "pad" ||
    entityKind === "sheet" ||
    entityKind === "git";
  // A feature-gated sink keeps its historical card and rename behavior but
  // cannot open a work detail surface in a build whose gate is off.
  const workDetailAllowed =
    isWorkSurface && productNodeKindEnabled(entityKind);
  const isCron = entityKind === "cron" || entityKind === "timer";

  useEffect(() => {
    if (editing) {
      setDraft(text);
      claimFocus(ref.current, "open", { select: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!isEditTarget) return;
    setDraft(text);
    // Artifacts shelf has no authorial name — node.text mirrors artifact
    // names — so it consumes the edit intent without opening rename/edit.
    if (entityKind === "artifacts") {
      state$.editNodeId.set("");
      return;
    }
    if (isLabel) setEditing(true);
    else if (isFreeNote) openNoteSurface(node);
    // Seat/shell/sink cards: rename first line (not full note textarea).
    else if (
      isTerminal ||
      isAgent ||
      managedTerminal ||
      isWorkSurface
    )
      setRenaming(true);
    else setEditing(true);
    state$.editNodeId.set("");
  }, [
    isEditTarget,
    node.id,
    isFreeNote,
    isTerminal,
    isAgent,
    managedTerminal,
    isWorkSurface,
    isLabel,
    entityKind,
    text,
  ]);

  // Cross-surface open trigger (RTS bars / jump-to-cause): mirrors editNodeId —
  // consume the target (+ optional item id), open the work-plane detail, clear.
  const isWorkDetailTarget = use$(
    () => workDetailOpen$.nodeId.get() === node.id,
  );
  useEffect(() => {
    if (!isWorkDetailTarget) return;
    const consumed = consumeWorkDetailOpen(node.id);
    if (!workDetailAllowed || !consumed) return;
    setWorkDetailItemId(consumed.itemId || undefined);
    setWorkDetail(true);
  }, [isWorkDetailTarget, workDetailAllowed, node.id]);


  const commit = () => {
    setEditing(false);
    if (draft !== text) editText(node.id, draft);
  };

  const discard = () => {
    setEditing(false);
    setDraft(text);
  };

  const openInline = () => {
    setDraft(text);
    setEditing(true);
  };

  const openMaximized = () => {
    setEditing(false);
    openNoteSurface(node);
  };

  const labelHue = node.color ? accentColor(node.color) : INK;

  // Both node kinds hold a seat, and the awareness plane observes both, so both
  // get the advisory hover. Collaboration is an agent seat's own surface: a
  // peer is another agent seat on this canvas. Everything renders through the
  // shell's overlay slot, which sits outside the clipped card body.
  const seatAwarenessOn = useSeatAwarenessOn();
  const seatNode = seatAwarenessOn && (managedTerminal || isAgent);
  const collaborationOpen = use$(seatCollaborationUi$.openNodeId) === node.id;
  // Visibility is the store, not `group-hover`: the slot is opened by the
  // same hover that sets it, so the two can never disagree, and a capture of
  // the page cannot show one state while the other is true.
  const collaborationOverlay = seatNode ? (
    <div
      className={collaborationOpen ? "absolute left-0 top-full z-50 pt-1" : "hidden"}
      data-collaboration-overlay={collaborationOpen ? "open" : undefined}
    >
      {collaborationOpen ? (
        <>
          {/* The advisory hover first: it is the status echo, collaboration is
              the action. Both live outside the clipped card body. */}
          <SeatAwarenessHoverForNode node={node} graphBlocked={data.blocked} />
          {isAgent ? (
            <SeatCollaborationBlock nodeId={node.id} className="mt-1" />
          ) : null}
        </>
      ) : null}
    </div>
  ) : undefined;
  const closeOnLeave = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A rebuilt card can deliver a leave for a pointer that never moved (the
    // node is replaced under the cursor and the browser reports no related
    // target). That leave is not the operator leaving the card.
    const next: unknown = event.relatedTarget;
    if (next === null || next === undefined) return;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    closeSeatCollaboration(node.id);
  };

  return (
    <NodeShell
      node={node}
      selected={selected}
      blocked={data.blocked}
      onMaximize={isFreeNote && !isLabel ? openMaximized : undefined}
      resizable={!isAgent}
      showHandles={!isLabel && !isGitNode(node)}
      bare={isLabel}
      toolbar={isLabel ? "minimal" : "full"}
      overlay={collaborationOverlay}
      onHoverEnter={seatNode ? () => openSeatCollaboration(node.id) : undefined}
      onHoverLeave={seatNode ? closeOnLeave : undefined}
      toolbarExtras={
        managedTerminal ? (
          <TerminalToolbarActions node={node} />
        ) : isAgent && !ACP_CHAT_SURFACE_HIDDEN ? (
          <AgentChatToolbarActions node={node} />
        ) : entityKind === "task" && TASKS_ENABLED ? (
          <TaskToolbarActions node={node} />
        ) : isCron ? (
          <CronScheduleToolbarAction onOpen={() => setCronScheduleOpen(true)} />
        ) : undefined
      }

    >
      {workDetail && workDetailAllowed && entityKind === "task" ? (
        <TasksDetail
          node={node}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "requests" ? (
        <RequestsDetail
          node={node}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "board" ? (
        <BoardDetail node={node} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "pad" ? (
        <PadDetail node={node} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "sheet" ? (
        <SheetDetail node={node} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && entityKind === "git" ? (
        <GitDetail node={node} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "artifacts" ? (
        <ArtifactsDetail
          node={node}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {isLabel ? (
        editing ? (
          <textarea
            ref={ref}
            data-focus-owner="canvas-draft"
            aria-label="Edit label"
            className="label-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent font-display outline-none"
            style={{ color: labelHue, fontSize: "15px", fontWeight: 650, letterSpacing: "0.02em", lineHeight: 1.25 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                discard();
              }
            }}
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="label-surface nopan flex h-full w-full cursor-text items-center overflow-hidden border-0 bg-transparent p-0 text-left font-display"
            style={{ color: labelHue, fontSize: "15px", fontWeight: 650, letterSpacing: "0.02em", lineHeight: 1.25 }}
            onClick={(event) => {
              if (event.shiftKey) return;
              if (!selected) return;
              event.stopPropagation();
              openInline();
            }}
            onDoubleClick={(event) => {
              if (event.shiftKey) return;
              event.preventDefault();
              event.stopPropagation();
              openInline();
            }}
            onKeyDown={(event) => {
              if (event.shiftKey) return;
              if (!selected) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openInline();
              }
            }}
          >
            <span className="block w-full truncate" title={text}>
              {text || "Label"}
            </span>
          </div>
        )
      ) : editing &&
        !managedTerminal &&
        !isWorkSurface ? (

        <textarea
          ref={ref}
          data-focus-owner="canvas-draft"
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
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            // Actors / terminals / sinks: open the live surface (same as
            // command-group re-tap activate). Cron keeps its schedule modal.
            if (managedTerminal || isAgent || isWorkSurface) {
              const result = activateNodeSurface(node);
              if (result.opened) return;
              // Work surfaces also open via local state when the trigger path
              // is unavailable (tests / no work-detail bus).
              if (workDetailAllowed) {
                setWorkDetail(true);
                return;
              }
              return;
            }
            if (isCron) {
              setCronScheduleOpen(true);
              return;
            }
            // Relay/gauge: RTS config pops; no card dbl-click surface yet.
            if (entityKind === "watcher" || entityKind === "relay") {

              return;
            }
            openInline();
          }}
        >
          {cronScheduleOpen && isCron ? (
            <CronScheduleSurface
              node={node}
              onClose={() => setCronScheduleOpen(false)}
            />
          ) : null}
          {entityKind === "watcher" ? (
            <WatcherCard node={node} label="gauge" />
          ) : entityKind === "relay" ? (
            <WatcherCard node={node} label="relay" />
          ) : entityKind === "timer" || entityKind === "cron" ? (
            <TimerCard node={node} />
          ) : entityKind === "task" ? (
            <TasksCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "requests" ? (
            <RequestsCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "artifacts" ? (
            <ArtifactsCard node={node} />
          ) : entityKind === "board" ? (
            <BoardCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "pad" ? (
            <PadCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "sheet" ? (
            <SheetCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "git" ? (
            <GitCard
              node={node}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "terminal" ? (
            <TerminalCard
              node={node}
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "agent" ? (
            <EntityCard
              node={node}
              kind="agent"
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
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
            if (event.shiftKey) return;
            if (!selected) return;
            event.stopPropagation();
            openInline();
          }}
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            openInline();
          }}
          onKeyDown={(event) => {
            if (event.shiftKey) return;

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
