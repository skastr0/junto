import { countRender } from "../../lib/performance/surface-commits";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { CanvasNode } from "@shared/canvas";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { Gauge, Radio, Settings2, Timer } from "lucide-react";

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
import { state$ } from "../../lib/state";
import { timerActivity, watcherActivity } from "../../lib/activity";
import { accentColor, INK } from "../../lib/theme";
import { kernel$ } from "../../lib/kernel-view";
import type { WatcherRuntimeState } from "../../lib/kernel-view";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { productNodeKindEnabled, TASKS_ENABLED } from "@shared/features";
import { consumeWorkDetailOpen, workDetailOpen$ } from "../../lib/work-detail-open";
import {
  markNoteSurfaceSaved,
  noteSurfaceId,
  openNoteSurface,
  updateNoteSurfaceDraft,
} from "../../lib/dock-state";
import { SeatAwarenessHoverForNode } from "../terminal/SeatAwarenessHoverForNode";
import { SeatCollaborationBlock } from "../terminal/SeatCollaborationBlock";
import { TerminalCard } from "../terminal/TerminalCard";
import {
  closeSeatCollaboration,
  openSeatCollaboration,
  seatCollaborationUi$,
} from "../../lib/seat-collaboration";
import { TerminalToolbarActions } from "../terminal/TerminalToolbarActions";
import { SeatMessageToolbarAction } from "./SeatMessage";
import { SeatOffboardToolbarAction } from "./SeatOffboard";
import { CustomizeAgentToolbarAction } from "../agent-editor/AgentEditor";
import { StartParamsToolbarAction } from "../customize/ParamsSection";
import { AgentChatToolbarActions } from "../chat/AgentChatToolbarActions";
import { claimFocus } from "../../lib/focus-ownership";
import { IconButton } from "../ui";
import { documentNodeAt, useDocumentNode } from "../../lib/document-node";
import { useNodeFieldOf, useNodeValue } from "../../lib/use-model";
import { SeatCard } from "./SeatCard";
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
import { INSTRUMENT_KINDS } from "../../lib/node-geometry";
import { GitDetail } from "../git/GitDetail";
import { TaskToolbarActions } from "../work/TaskToolbarActions";

import { NodeShell } from "./NodeShell";
import { keyIs } from "../../lib/key-match";

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
  canvas,
  id,
  label,
}: {
  readonly canvas: string;
  readonly id: string;
  readonly label: "gauge" | "relay";
}) {
  const runtime = use$(kernel$.watchers[id]) as
    WatcherRuntimeState | undefined;
  const now = useRelativeNow(30_000);
  const name = useNodeValue(canvas, id, (node) =>
    node?.kind === "watcher" || node?.kind === "relay" ? node.label : undefined,
  );
  const title = name || label;
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
function TimerCard({ canvas, id }: { readonly canvas: string; readonly id: string }) {
  const nextFire = use$(kernel$.nextFire[id]) as number | undefined;
  const now = useRelativeNow(30_000);
  const name = useNodeFieldOf(canvas, id, "cron", (cron) => cron.label);
  const title = name || "cron";
  const expression = cronExpressionOf({
    expression: useNodeFieldOf(canvas, id, "cron", (cron) => cron.expression),
  });
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

// Freeform note body: instrument mono for body; condensed display for heads
// (CSS). Markdown is structure only — no wiki/chips/shorthand leak.

/** The kinds whose card body still takes the document's node. */
const DOCUMENT_BODY_KINDS: ReadonlySet<string> = new Set(["task", "requests", "artifacts", "board", "pad", "sheet", "git"]);

/**
 * Draws what still takes the document's node, and follows that node itself,
 * so the card around it does not render when the node moves. Nothing is drawn
 * until the document holds the node.
 */
function WithDocumentNode({
  id,
  children,
}: {
  readonly id: string;
  readonly children: (node: CanvasNode) => ReactNode;
}): ReactNode {
  const node = useDocumentNode(id);
  return node === undefined ? null : children(node);
}

export function TextNode({ id, data, selected }: NodeProps<FlowNode>) {
  countRender("text-card", id);
  const canvasName = use$(state$.canvasName);
  // What the card is and what it says, from the node store, one field each.
  const kind = useNodeValue(canvasName, id, (node) => node?.kind);
  const text = useNodeValue(canvasName, id, (node) =>
    node?.kind === "note" || node?.kind === "label" ? node.text : "",
  );
  const color = useNodeValue(canvasName, id, (node) => node?.color);
  // The bodies that have not moved onto the store still take the document's
  // node. Each follows it for itself (WithDocumentNode), so the card around
  // them does not render when its node moves; what only needs the node at the
  // moment of an act reads it then.
  const isLabel = kind === "label";
  const isFreeNote = kind === "note";
  const isTerminal = kind === "terminal";
  const isAgent = kind === "agent";
  // A seat and a terminal in the model always hold a session binding.
  const managedTerminal = isTerminal || isAgent;
  // Boolean selector: only this node re-renders when edit intent targets it.
  const isEditTarget = use$(() => state$.editNodeId.get() === id);

  // The note editor opens on the document's node, with the store's text.
  const openNote = (shown: string = text): void => {
    const node = documentNodeAt(id);
    if (node?.type === "text") openNoteSurface({ ...node, text: shown });
  };
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [workDetail, setWorkDetail] = useState(false);
  const [workDetailItemId, setWorkDetailItemId] = useState<string | undefined>();
  const [cronScheduleOpen, setCronScheduleOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const entityKind = kind;
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
  const isCron = entityKind === "cron";

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
    else if (isFreeNote) openNote();
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
    id,
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
    () => workDetailOpen$.nodeId.get() === id,
  );
  useEffect(() => {
    if (!isWorkDetailTarget) return;
    const consumed = consumeWorkDetailOpen(id);
    if (!workDetailAllowed || !consumed) return;
    setWorkDetailItemId(consumed.itemId || undefined);
    setWorkDetail(true);
  }, [isWorkDetailTarget, workDetailAllowed, id]);


  const commit = () => {
    setEditing(false);
    if (draft !== text) editText(id, draft);
  };

  const discard = () => {
    setEditing(false);
    setDraft(text);
  };

  const openInline = () => {
    setDraft(text);
    setEditing(true);
  };

  // Expand takes the press without blurring the in-place field, so nothing
  // else commits what was typed there: save it, and open the editor on it.
  const openMaximized = () => {
    const typed = editing ? draft : text;
    setEditing(false);
    if (typed === text) {
      openNote();
      return;
    }
    editText(id, typed);
    openNote(typed);
    const surfaceId = noteSurfaceId(id);
    updateNoteSurfaceDraft(surfaceId, typed);
    markNoteSurfaceSaved(surfaceId, typed);
  };

  const labelHue = color ? accentColor(color) : INK;

  // Both node kinds hold a seat, and the awareness plane observes both, so both
  // get the advisory hover. Collaboration is an agent seat's own surface: a
  // peer is another agent seat on this canvas. Everything renders through the
  // shell's overlay slot, which sits outside the clipped card body.
  const seatAwarenessOn = useSeatAwarenessOn();
  const seatNode = seatAwarenessOn && (managedTerminal || isAgent);
  const collaborationOpen = use$(seatCollaborationUi$.openNodeId) === id;
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
          <SeatAwarenessHoverForNode canvas={canvasName} id={id} graphBlocked={data.blocked} />
          {isAgent ? (
            <SeatCollaborationBlock nodeId={id} className="mt-1" />
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
    closeSeatCollaboration(id);
  };

  return (
    <NodeShell
      canvas={canvasName}
      id={id}
      selected={selected}
      blocked={data.blocked}
      onMaximize={isFreeNote && !isLabel ? openMaximized : undefined}
      resizable={!isAgent && !INSTRUMENT_KINDS.has(entityKind ?? "")}
      showHandles={!isLabel && kind !== "git"}
      bare={isLabel}
      toolbar={isLabel ? "minimal" : "full"}
      overlay={collaborationOverlay}
      onHoverEnter={seatNode ? () => openSeatCollaboration(id) : undefined}
      onHoverLeave={seatNode ? closeOnLeave : undefined}
      toolbarExtras={
        managedTerminal ? (
          <>
            {isAgent ? <CustomizeAgentToolbarAction seatId={id} /> : null}
            {isAgent ? <StartParamsToolbarAction seatId={id} /> : null}
            {isAgent ? <SeatMessageToolbarAction id={id} /> : null}
            {isAgent ? <SeatOffboardToolbarAction canvas={canvasName} id={id} /> : null}
            <WithDocumentNode id={id}>{(node) => <TerminalToolbarActions node={node} />}</WithDocumentNode>
          </>
        ) : isAgent ? (
          <>
            <CustomizeAgentToolbarAction seatId={id} />
            {ACP_CHAT_SURFACE_HIDDEN ? null : (
              <WithDocumentNode id={id}>{(node) => <AgentChatToolbarActions node={node} />}</WithDocumentNode>
            )}
          </>
        ) : entityKind === "task" && TASKS_ENABLED ? (
          <WithDocumentNode id={id}>{(node) => <TaskToolbarActions node={node} />}</WithDocumentNode>
        ) : isCron ? (
          <CronScheduleToolbarAction onOpen={() => setCronScheduleOpen(true)} />
        ) : undefined
      }

    >
      {workDetail && workDetailAllowed && entityKind === "task" ? (
        <TasksDetail
          nodeId={id}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "requests" ? (
        <RequestsDetail
          nodeId={id}
          initialItemId={workDetailItemId}
          onClose={() => {
            setWorkDetail(false);
            setWorkDetailItemId(undefined);
          }}
        />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "board" ? (
        <BoardDetail nodeId={id} onClose={() => setWorkDetail(false)} />
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "pad" ? (
        <WithDocumentNode id={id}>
          {(node) => (
            <PadDetail node={node} onClose={() => setWorkDetail(false)} />
          )}
        </WithDocumentNode>
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "sheet" ? (
        <WithDocumentNode id={id}>
          {(node) => (
            <SheetDetail node={node} onClose={() => setWorkDetail(false)} />
          )}
        </WithDocumentNode>
      ) : null}
      {workDetail && entityKind === "git" ? (
        <WithDocumentNode id={id}>
          {(node) => (
            <GitDetail node={node} onClose={() => setWorkDetail(false)} />
          )}
        </WithDocumentNode>
      ) : null}
      {workDetail && workDetailAllowed && entityKind === "artifacts" ? (
        <ArtifactsDetail
          nodeId={id}
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
            if (keyIs(e, "message.send")) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              discard();
            }
          }}
        />
      ) : kind !== undefined && kind !== "note" ? (
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            // Actors / terminals / sinks: open the live surface (same as
            // command-group re-tap activate). Cron keeps its schedule modal.
            if (managedTerminal || isAgent || isWorkSurface) {
              const node = documentNodeAt(id);
              if (!node) return;
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
            <WithDocumentNode id={id}>
              {(node) => <CronScheduleSurface node={node} onClose={() => setCronScheduleOpen(false)} />}
            </WithDocumentNode>
          ) : null}
          {entityKind === "watcher" ? (
            <WatcherCard canvas={canvasName} id={id} label="gauge" />
          ) : entityKind === "relay" ? (
            <WatcherCard canvas={canvasName} id={id} label="relay" />
          ) : entityKind === "cron" ? (
            <TimerCard canvas={canvasName} id={id} />
          ) : entityKind === "terminal" ? (
            <TerminalCard
              canvas={canvasName}
              id={id}
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : entityKind === "agent" ? (
            <SeatCard
              canvas={canvasName}
              id={id}
              graphBlocked={data.blocked}
              renaming={renaming}
              onRenameDone={() => setRenaming(false)}
            />
          ) : DOCUMENT_BODY_KINDS.has(entityKind ?? "") ? (
            <WithDocumentNode id={id}>
              {(node) =>
                entityKind === "task" ? (
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
                ) : null
              }
            </WithDocumentNode>
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
