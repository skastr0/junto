import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  Activity,
  CheckCircle2,
  CircleDot,
  CircleHelp,
  Filter,
  GripVertical,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  MessageSquareWarning,
  MoreHorizontal,
  PanelRightClose,
  Paperclip,
  Plus,
  Reply,
  RotateCcw,
  Search,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import {
  DragDropProvider,
  DragOverlay,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { CanvasDoc, CanvasNode, Part, TaskState, WorkMetadata } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import { sinkGlance, workRoleOf, workRolesInDoc } from "@shared/attention";
import {
  canTransitionTaskState,
  claimedByOf,
  taskBrief,
  taskContentParts,
  taskMediaParts,
  validateTaskMediaParts,
} from "@shared/task";
import { ContentMedia } from "./ContentMedia";
import { dependencyScopeTasks } from "@shared/task-dep-scope";
import {
  taskDepStatus,
  taskIndexById,
  type TaskDepStatus,
} from "@shared/task-deps";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { Chip, type ChipTone } from "../ui/Chip";
import { Dropdown } from "../ui/Dropdown";
import { IconButton } from "../ui/IconButton";
import { Input, Textarea } from "../ui/Field";
import { OverlayHeader } from "../ui/OverlayHeader";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { applyWorkCanvasWrite, setNodeWorkRole } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import {
  extractHerdrClipboardImage,
  fileToHerdrClipboardImage,
  type HerdrClipboardImage,
} from "../../lib/herdr-clipboard-image";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import "./task-board.css";

/** Prefer artifacts sinks edge-linked to the task node; else first on canvas. */
const resolveArtifactsNodeId = (
  taskNodeId: string,
  doc: CanvasDoc,
): string | undefined => {
  const artifacts = doc.nodes.filter(
    (entry) => entry.ether?.entity?.kind === "artifacts",
  );
  if (artifacts.length === 0) return undefined;
  const linked = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === taskNodeId) linked.add(edge.toNode);
    if (edge.toNode === taskNodeId) linked.add(edge.fromNode);
  }
  return (artifacts.find((entry) => linked.has(entry.id)) ?? artifacts[0])?.id;
};

function FieldHelp({ text }: { readonly text: string }) {
  return (
    <button
      type="button"
      className="task-create-dialog__help"
      data-tooltip={text}
      aria-label={text}
      tabIndex={-1}
      onClick={(event) => event.preventDefault()}
    >
      <CircleHelp size={11} aria-hidden />
    </button>
  );
}

function FieldCaption({
  label,
  help,
  action,
}: {
  readonly label: string;
  readonly help?: string;
  readonly action?: ReactNode;
}) {
  return (
    <span className="task-create-dialog__caption">
      <span className="task-create-dialog__caption-text">
        {label}
        {help ? <FieldHelp text={help} /> : null}
      </span>
      {action}
    </span>
  );
}

type TaskMediaDraft = {
  readonly id: string;
  readonly mediaType: string;
  readonly bytesBase64: string;
  readonly previewUrl: string;
  readonly label: string;
};

const EXT_TO_MEDIA_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const mediaTypeFromExtension = (extension: string): string =>
  EXT_TO_MEDIA_TYPE[extension.toLowerCase()] ?? `image/${extension.toLowerCase()}`;

const draftFromClipboardImage = (
  image: HerdrClipboardImage,
  label: string,
): TaskMediaDraft => {
  const mediaType = mediaTypeFromExtension(image.extension);
  return {
    id: `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mediaType,
    bytesBase64: image.dataBase64,
    previewUrl: `data:${mediaType};base64,${image.dataBase64}`,
    label,
  };
};

const mediaPartsFromDrafts = (
  drafts: ReadonlyArray<TaskMediaDraft>,
): ReadonlyArray<Extract<Part, { kind: "raw" }>> =>
  drafts.map((draft) => ({
    kind: "raw" as const,
    bytesBase64: draft.bytesBase64,
    mediaType: draft.mediaType,
  }));

type Ether = NonNullable<CanvasNode["ether"]>;
type WorkTask = NonNullable<Ether["tasks"]>["items"][number];
type WorkProposal = NonNullable<NonNullable<Ether["tasks"]>["proposals"]>[number];

/**
 * Map a pending proposal onto the Task display shape so the board card + detail
 * panel can show the same authoring fields (brief/media, metadata, dependsOn,
 * finishCriteria, reason) without a second detail surface.
 */
export const proposalAsDisplayTask = (proposal: WorkProposal): WorkTask => ({
  id: proposal.id,
  state: "submitted",
  history: [proposal.brief],
  ...(proposal.metadata ? { metadata: proposal.metadata } : {}),
  ...(proposal.reason ? { reason: proposal.reason } : {}),
  ...(proposal.dependsOn && proposal.dependsOn.length > 0
    ? { dependsOn: proposal.dependsOn }
    : {}),
  ...(proposal.finishCriteria ? { finishCriteria: proposal.finishCriteria } : {}),
});

type LaneId = "proposal" | "queue" | "working" | "input" | "closed";

type TaskDragData = {
  readonly kind: "task";
  readonly taskId: string;
  readonly laneId: LaneId;
};

type LaneDragData = {
  readonly kind: "lane";
  readonly laneId: LaneId;
};

type BoardDragData = TaskDragData | LaneDragData;

type DescribeApi = {
  readonly workTaskDescribe?: (
    canvas: string,
    nodeId: string,
    taskId: string,
    brief: string,
  ) => Promise<WorkOpResult<unknown>>;
};

type LaneDefinition = {
  readonly id: LaneId;
  readonly label: string;
  readonly state?: TaskState;
  readonly tone: StatusTone;
  readonly chipTone: ChipTone;
  readonly icon: typeof CircleDot;
  readonly hint: string;
};

const LANES: ReadonlyArray<LaneDefinition> = [
  {
    id: "proposal",
    label: "Proposals",
    tone: "violet",
    chipTone: "violet",
    icon: UserRound,
    hint: "Planning drafts — approve to Queue when ready for workers",
  },
  {
    id: "queue",
    label: "Queue",
    state: "submitted",
    tone: "amber",
    chipTone: "amber",
    icon: CircleDot,
    hint: "Ready to be claimed",
  },
  {
    id: "working",
    label: "Working",
    state: "working",
    tone: "cyan",
    chipTone: "cyan",
    icon: LoaderCircle,
    hint: "Claimed work in motion",
  },
  {
    id: "input",
    label: "Needs input",
    state: "input-required",
    tone: "amber",
    chipTone: "amber",
    icon: MessageSquareWarning,
    hint: "Waiting for operator context",
  },
  {
    id: "closed",
    label: "Closed",
    tone: "green",
    chipTone: "green",
    icon: CheckCircle2,
    hint: "Completed and stopped work · open a completed task to QA-reject it",
  },
];

const TERMINAL_STATES = new Set<TaskState>([
  "completed",
  "canceled",
  "failed",
  "rejected",
  "archived",
]);

export const isTaskClaimantRetired = (
  state: TaskState,
  claimedBy: string | undefined,
  activeActorSeatIds: ReadonlySet<string>,
): boolean =>
  claimedBy !== undefined
  && !TERMINAL_STATES.has(state)
  && !activeActorSeatIds.has(claimedBy);

const laneForTask = (task: WorkTask): LaneId => {
  if (TERMINAL_STATES.has(task.state)) return "closed";
  if (task.state === "submitted") return "queue";
  if (task.state === "working") return "working";
  // input-required and residual durable auth-required share one attention lane
  if (task.state === "input-required" || task.state === "auth-required") return "input";
  return "queue";
};

const stateLabel = (state: TaskState): string => {
  switch (state) {
    case "submitted":
      return "Queued";
    case "working":
      return "Working";
    case "input-required":
    case "auth-required":
      return "Input needed";
    case "completed":
      return "Completed";
    case "canceled":
      return "Canceled";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "archived":
      return "Archived";
  }
};

const toneForState = (state: TaskState): StatusTone => {
  if (state === "working") return "cyan";
  if (state === "completed") return "green";
  if (state === "failed" || state === "rejected") return "crimson";
  if (state === "canceled" || state === "archived") return "dim";
  return "amber";
};

const chipToneForState = (state: TaskState): ChipTone => {
  const tone = toneForState(state);
  return tone === "dim" ? "steel" : tone;
};

const metadataText = (metadata: WorkMetadata | undefined, key: string): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const taskTitle = (task: WorkTask): string =>
  metadataText(task.metadata, "title") ?? taskBrief(task).split(/\r?\n/, 1)[0]?.trim() ?? "Untitled task";

const taskDetails = (task: WorkTask): string | undefined =>
  metadataText(task.metadata, "details");

const taskRole = (task: WorkTask): string | undefined =>
  metadataText(task.metadata, "workRole");

const depGlance = (
  status: TaskDepStatus,
): { readonly label: string; readonly tone: ChipTone } | undefined => {
  switch (status.kind) {
    case "ready":
      return undefined;
    case "waiting":
      return {
        label: `Waiting · ${status.frontier.join(", ")}`,
        tone: "amber",
      };
    case "blocked":
      return {
        label: `Blocked · ${status.roots.join(", ")}`,
        tone: "crimson",
      };
    case "orphan":
      return {
        label: `Missing · ${status.missing.join(", ")}`,
        tone: "crimson",
      };
  }
};

const latestText = (task: WorkTask): string | undefined => {
  for (let messageIndex = task.history.length - 1; messageIndex >= 1; messageIndex -= 1) {
    const message = task.history[messageIndex];
    if (!message) continue;
    const text = message.parts
      .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  return undefined;
};

const canvasName = (): string => state$.canvasName.peek() || "";

const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

const runWorkCanvasMutation = <T,>(
  canvas: string,
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> =>
  runCanvasAuthoringOperation(async () => acceptWorkResult(canvas, await operation()));

const destinationState = (laneId: LaneId): TaskState | undefined =>
  LANES.find((lane) => lane.id === laneId)?.state;

function TaskLane({
  lane,
  tasks,
  allTasks,
  searchActive,
  activeLane,
  pendingTaskId,
  editingTaskId,
  selectedTaskId,
  activeActorSeatIds,
  proposalById,
  onCreate,
  onApprove,
  onRejectProposal,
  onSelect,
  onMove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly lane: LaneDefinition;
  readonly tasks: ReadonlyArray<WorkTask>;
  readonly allTasks: ReadonlyArray<WorkTask>;
  readonly searchActive: boolean;
  readonly activeLane: LaneId | null;
  readonly pendingTaskId: string | null;
  readonly editingTaskId: string | null;
  readonly selectedTaskId: string | null;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly proposalById: ReadonlyMap<string, string>;
  readonly onCreate: () => void;
  readonly onApprove: (task: WorkTask) => void;
  readonly onRejectProposal?: (task: WorkTask) => void;
  readonly onSelect: (taskId: string) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onEdit: (task: WorkTask) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (task: WorkTask, brief: string) => void;
}) {
  const laneDrop = useDroppable<LaneDragData>({
    id: `lane:${lane.id}`,
    data: { kind: "lane", laneId: lane.id },
    type: "lane",
    accept: "task",
  });
  const Icon = lane.icon;
  const isTarget = laneDrop.isDropTarget || activeLane === lane.id;

  return (
    <section
      ref={laneDrop.ref}
      className={[
        "task-board-lane",
        isTarget ? "task-board-lane--target" : "",
        lane.id === "input" ? "task-board-lane--attention" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={`task-lane-${lane.id}`}
      data-lane={lane.id}
      data-testid={`task-lane-${lane.id}`}
    >
      <header className="task-board-lane__header">
        <div className="task-board-lane__title-wrap">
          <Icon size={13} aria-hidden />
          <h2 id={`task-lane-${lane.id}`} className="task-board-lane__title">
            {lane.label}
          </h2>
          <span className="task-board-lane__count" aria-label={`${tasks.length} tasks`}>
            {tasks.length}
          </span>
        </div>
        {lane.id === "queue" || lane.id === "proposal" ? (
          <IconButton
            size="sm"
            tone="accent"
            aria-label={
              lane.id === "proposal" ? "Create proposal" : "Create task in Queue"
            }
            title={lane.id === "proposal" ? "Create proposal" : "Create task"}
            onClick={onCreate}
          >
            <Plus size={13} />
          </IconButton>
        ) : null}
      </header>
      <p className="task-board-lane__hint">{lane.hint}</p>

      <div className="task-board-lane__list" role="list">
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            allTasks={allTasks}
            lane={lane}
            index={index}
            pending={pendingTaskId === task.id}
            editing={editingTaskId === task.id}
            selected={selectedTaskId === task.id}
            activeActorSeatIds={activeActorSeatIds}
            proposalBy={proposalById.get(task.id)}
            onSelect={onSelect}
            onMove={onMove}
            onApprove={onApprove}
            onRejectProposal={onRejectProposal}
            onEdit={onEdit}
            onCancelEdit={onCancelEdit}
            onSaveEdit={onSaveEdit}
          />
        ))}
        {tasks.length === 0 ? (
          <div className="task-board-lane__empty">
            <span>
              {searchActive
                ? "No matching tasks"
                : lane.id === "proposal"
                  ? "No proposals yet"
                  : `No ${lane.label.toLowerCase()}`}
            </span>
            {(lane.id === "queue" || lane.id === "proposal") && !searchActive ? (
              <button type="button" onClick={onCreate}>
                {lane.id === "proposal"
                  ? "Create the first proposal"
                  : "Create the first task"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskActionsMenu({
  task,
  lane,
  pending,
  isProposal,
  onEdit,
  onMove,
  onApprove,
  onRejectProposal,
}: {
  readonly task: WorkTask;
  readonly lane: LaneDefinition;
  readonly pending: boolean;
  readonly isProposal: boolean;
  readonly onEdit: (task: WorkTask) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onApprove: (task: WorkTask) => void;
  readonly onRejectProposal?: (task: WorkTask) => void;
}) {
  const menuId = `task-actions-${useId().replaceAll(":", "")}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const brief = taskTitle(task);
  const availableMoves = LANES.filter(
    (destination) =>
      destination.state &&
      destination.id !== lane.id &&
      !(task.state === "completed" && destination.state === "submitted") &&
      canTransitionTaskState(task.state, destination.state),
  );
  const hardFinishGate =
    task.finishCriteria?.artifacts !== undefined ||
    task.finishCriteria?.git !== undefined;
  const terminalActions = (
    [
      ["completed", "Complete task"],
      ["failed", "Mark as failed"],
      ["rejected", "Reject task"],
      ["canceled", "Cancel task"],
      ["archived", "Delete from board"],
    ] as const
  ).filter(([state]) => {
    if (!canTransitionTaskState(task.state, state)) return false;
    // Hard finish criteria require completionEvidence (CLI/agent only for now).
    if (state === "completed" && hardFinishGate) return false;
    return true;
  });

  const show = (trigger: HTMLButtonElement) => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 220)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - 174, window.innerWidth - 182))}px`;
    menu.showPopover();
  };

  const commit = (action: () => void) => {
    menuRef.current?.hidePopover();
    action();
  };

  return (
    <>
      <button
        type="button"
        className="task-board-card__menu-trigger"
        aria-label={`Actions for ${brief}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="Task actions"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          show(event.currentTarget);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        className="task-board-card__menu-popover"
        onClick={(event) => event.stopPropagation()}
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      >
        {isProposal ? (
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => commit(() => onApprove(task))}
          >
            Approve to Queue
          </button>
        ) : null}
        {isProposal && onRejectProposal ? (
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => commit(() => onRejectProposal(task))}
          >
            Reject proposal
          </button>
        ) : null}
        {!isProposal ? (
          <button type="button" role="menuitem" onClick={() => commit(() => onEdit(task))}>
            Edit title
          </button>
        ) : null}
        {availableMoves.map((destination) => (
          <button
            key={destination.id}
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() =>
              commit(() => {
                if (destination.state) onMove(task, destination.state);
              })
            }
          >
            {destination.id === "queue" ? "Unclaim to Queue" : `Move to ${destination.label}`}
          </button>
        ))}
        {terminalActions.length > 0 ? (
          <div className="task-board-card__menu-separator" aria-hidden />
        ) : null}
        {terminalActions.map(([state, label]) => (
          <button
            key={state}
            type="button"
            role="menuitem"
            disabled={pending}
            data-terminal-action={state}
            onClick={() => commit(() => onMove(task, state))}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

function TaskCard({
  task,
  allTasks,
  lane,
  index,
  pending,
  editing,
  selected,
  activeActorSeatIds,
  proposalBy,
  onSelect,
  onMove,
  onApprove,
  onRejectProposal,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly task: WorkTask;
  readonly allTasks: ReadonlyArray<WorkTask>;
  readonly lane: LaneDefinition;
  readonly index: number;
  readonly pending: boolean;
  readonly editing: boolean;
  readonly selected: boolean;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly proposalBy?: string;
  readonly onSelect: (taskId: string) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onApprove: (task: WorkTask) => void;
  readonly onRejectProposal?: (task: WorkTask) => void;
  readonly onEdit: (task: WorkTask) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (task: WorkTask, brief: string) => void;
}) {
  const [draft, setDraft] = useState(() => taskBrief(task));
  const sortable = useSortable<TaskDragData>({
    id: task.id,
    index,
    group: lane.id,
    type: "task",
    accept: "task",
    data: { kind: "task", taskId: task.id, laneId: lane.id },
    disabled: TERMINAL_STATES.has(task.state) || proposalBy !== undefined || pending,
    transition: {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      idle: true,
    },
  });
  const brief = taskTitle(task);
  const claim = claimedByOf(task);
  const claimantRetired = isTaskClaimantRetired(
    task.state,
    claim,
    activeActorSeatIds,
  );
  const role = taskRole(task);
  const context = latestText(task);
  const mediaCount =
    taskMediaParts(task).length + taskContentParts(task).length;
  const depChip =
    task.state === "submitted" && !claim
      ? depGlance(taskDepStatus(task, taskIndexById(allTasks)))
      : undefined;

  return (
    <article
      ref={sortable.ref}
      className={[
        "task-board-card",
        `task-board-card--${lane.id}`,
        sortable.isDragging ? "task-board-card--dragging" : "",
        sortable.isDropTarget ? "task-board-card--drop-target" : "",
        pending ? "task-board-card--pending" : "",
        selected ? "task-board-card--selected" : "",
        claimantRetired ? "task-board-card--retired-seat" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-state={task.state}
      data-draggable={
        TERMINAL_STATES.has(task.state) || proposalBy !== undefined || pending
          ? "false"
          : "true"
      }
      data-testid="task-board-card"
      role="listitem"
      tabIndex={0}
      aria-busy={pending}
      aria-label={`Open details for ${brief}${
        mediaCount > 0 ? `, ${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}` : ""
      }${
        claimantRetired ? ", stalled because its claimed seat is retired" : ""
      }`}
      aria-current={selected ? "true" : undefined}
      onClick={() => {
        if (!editing) onSelect(task.id);
      }}
      onKeyDown={(event) => {
        if (!editing && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(task.id);
        }
      }}
    >
      <div className="task-board-card__topline">
        <span
          className="task-board-card__handle"
          aria-hidden
          title={
            task.state === "completed"
              ? "Completed tasks return through QA review"
              : TERMINAL_STATES.has(task.state)
                ? "Closed tasks cannot move"
                : "Drag task"
          }
        >
          <GripVertical size={14} />
        </span>

        <div className="task-board-card__content">
          {editing ? (
            <form
              className="task-board-card__editor"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveEdit(task, draft);
              }}
            >
              <label htmlFor={`task-title-${task.id}`}>Task title</label>
              <Input
                id={`task-title-${task.id}`}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="task-board-card__editor-actions">
                <Button size="xs" variant="subtle" onClick={onCancelEdit}>
                  Keep current
                </Button>
                <Button size="xs" variant="primary" type="submit" disabled={!draft.trim()}>
                  Save title
                </Button>
              </div>
            </form>
          ) : (
            <>
              <h3 className="task-board-card__title">{brief}</h3>
              <div className="task-board-card__meta">
                <StatusDot
                  tone={claimantRetired ? "crimson" : toneForState(task.state)}
                  pulse={!claimantRetired && task.state === "working"}
                />
                <span className="task-board-card__claimant" title={claim}>
                  {proposalBy
                    ? proposalBy === "operator"
                      ? "Proposed by operator"
                      : `Proposed by ${proposalBy}`
                    : claim ?? "Unclaimed"}
                </span>
                {role ? <span className="task-board-card__role">{role}</span> : null}
                {mediaCount > 0 ? (
                  <span
                    className="task-board-card__media"
                    title={`${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}`}
                  >
                    <Paperclip size={11} aria-hidden />
                    {mediaCount}
                  </span>
                ) : null}
              </div>
              {context && (task.state === "input-required" || task.state === "auth-required") ? (
                <p className="task-board-card__context">{context}</p>
              ) : null}
            </>
          )}
        </div>

        {!editing ? (
          <TaskActionsMenu
            task={task}
            lane={lane}
            pending={pending}
            isProposal={proposalBy !== undefined}
            onEdit={onEdit}
            onMove={onMove}
            onApprove={onApprove}
            onRejectProposal={onRejectProposal}
          />
        ) : null}
      </div>

      {!editing ? (
        <footer className="task-board-card__footer">
          <div className="task-board-card__status-chips">
            <Chip
              tone={
                proposalBy !== undefined ? "violet" : chipToneForState(task.state)
              }
            >
              {proposalBy !== undefined ? "Proposed" : stateLabel(task.state)}
            </Chip>
            {depChip ? (
              <Chip
                tone={depChip.tone}
                title={
                  task.dependsOn && task.dependsOn.length > 0
                    ? `dependsOn: ${task.dependsOn.join(", ")}`
                    : undefined
                }
              >
                {depChip.label}
              </Chip>
            ) : null}
            {claimantRetired ? (
              <Chip
                tone="crimson"
                title="This task remains claimed, but its ActorSeatId is absent from the current actor projection."
              >
                Stalled · retired seat
              </Chip>
            ) : null}
          </div>
          {task.history.length > 1 ? (
            <span className="task-board-card__history">
              {task.history.length - 1} update{task.history.length === 2 ? "" : "s"}
            </span>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function DragCardPreview({ task }: { readonly task: WorkTask }) {
  return (
    <div className="task-board-card task-board-card--preview">
      <div className="task-board-card__topline">
        <span className="task-board-card__handle" aria-hidden>
          <GripVertical size={14} />
        </span>
        <div className="task-board-card__content">
          <h3 className="task-board-card__title">{taskTitle(task)}</h3>
          <div className="task-board-card__meta">
            <StatusDot tone={toneForState(task.state)} />
            <span className="task-board-card__claimant">
              {claimedByOf(task) ?? "Unclaimed"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

type CreateDialogMode = "task" | "proposal";

/** Focus portal (board) or inline workbench pane (pinnable enqueue). */
export type TaskCreateShell = "focus" | "inline";

export function TaskCreateDialog({
  mode,
  roles,
  pending,
  artifactsNodeId,
  onClose,
  onCreate,
  shell = "focus",
  stayOpen = false,
  resetToken = 0,
  headerActions,
}: {
  readonly mode: CreateDialogMode;
  readonly roles: ReadonlyArray<string>;
  readonly pending: boolean;
  /** Resolved from canvas; not operator-authored at create. */
  readonly artifactsNodeId: string | undefined;
  readonly onClose: () => void;
  readonly onCreate: (
    title: string,
    details: string,
    role: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string>,
    finishCriteria: import("@shared/work-model").FinishCriteria | undefined,
  ) => void;
  readonly shell?: TaskCreateShell;
  /**
   * When true, submit does not imply dismiss — caller keeps the surface open
   * and bumps `resetToken` after a successful create so fields clear for the next.
   */
  readonly stayOpen?: boolean;
  readonly resetToken?: number;
  /** Extra header actions (pin/close) for workbench chrome. */
  readonly headerActions?: ReactNode;
}) {
  const isProposal = mode === "proposal";
  const roleListId = `task-role-options-${useId().replaceAll(":", "")}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [role, setRole] = useState("");
  const [dependsOnText, setDependsOnText] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [requireArtifacts, setRequireArtifacts] = useState(false);
  const [artifactsInstruction, setArtifactsInstruction] = useState("");
  const [artifactNamesText, setArtifactNamesText] = useState("");
  const [requireGit, setRequireGit] = useState(false);
  const [media, setMedia] = useState<TaskMediaDraft[]>([]);
  const [mediaError, setMediaError] = useState("");
  const [formError, setFormError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    if (resetToken === 0) return;
    setTitle("");
    setDetails("");
    setRole("");
    setDependsOnText("");
    setCriteriaText("");
    setRequireArtifacts(false);
    setArtifactsInstruction("");
    setArtifactNamesText("");
    setRequireGit(false);
    setMedia([]);
    setMediaError("");
    setFormError("");
    setDragOver(false);
    setDescriptionOpen(false);
    setFlash(isProposal ? "Proposed — ready for next" : "Queued — ready for next");
  }, [resetToken, isProposal]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(""), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const appendMedia = (draft: TaskMediaDraft) => {
    setMedia((current) => {
      const next = [...current, draft];
      const validation = validateTaskMediaParts(mediaPartsFromDrafts(next));
      if (validation) {
        setMediaError(validation);
        return current;
      }
      setMediaError("");
      return next;
    });
  };

  const ingestClipboardOrFiles = async (data: DataTransfer | null | undefined) => {
    if (!data) return false;
    const image = await extractHerdrClipboardImage(data);
    if (image === null) return false;
    if ("error" in image) {
      setMediaError(image.error);
      return true;
    }
    appendMedia(draftFromClipboardImage(image, `paste-${image.extension}`));
    return true;
  };

  const ingestFileList = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const image = await fileToHerdrClipboardImage(file);
      if ("error" in image) {
        setMediaError(image.error);
        continue;
      }
      appendMedia(draftFromClipboardImage(image, file.name || `upload-${image.extension}`));
    }
  };

  const formBody = (
        <form
          className="task-create-dialog__form"
          data-shell={shell}
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            if (!details.trim()) {
              setFormError("Description is required.");
              return;
            }
            setFormError("");
            const parts = mediaPartsFromDrafts(media);
            const validation = validateTaskMediaParts(parts);
            if (validation) {
              setMediaError(validation);
              return;
            }
            const dependsOn = dependsOnText
              .split(/[,\s]+/)
              .map((id) => id.trim())
              .filter(Boolean);
            const names = artifactNamesText
              .split(/[\n,]+/)
              .map((n) => n.trim())
              .filter(Boolean);
            if (requireArtifacts && !artifactsNodeId) {
              setFormError("No artifacts sink on this canvas — draw one before requiring artifacts.");
              return;
            }
            const finishCriteria: import("@shared/work-model").FinishCriteria | undefined = (() => {
              const description = criteriaText.trim();
              const artifacts =
                requireArtifacts && artifactsNodeId
                  ? {
                      nodeId: artifactsNodeId,
                      ...(artifactsInstruction.trim()
                        ? { instruction: artifactsInstruction.trim() }
                        : {}),
                      ...(names.length > 0 ? { names } : {}),
                    }
                  : undefined;
              const git = requireGit ? { minCommits: 1 } : undefined;
              if (!description && !artifacts && !git) return undefined;
              return {
                ...(description ? { description } : {}),
                ...(artifacts ? { artifacts } : {}),
                ...(git ? { git } : {}),
              };
            })();
            onCreate(
              title.trim(),
              details.trim(),
              role.trim(),
              parts,
              dependsOn,
              finishCriteria,
            );
          }}
          onPaste={(event) => {
            void ingestClipboardOrFiles(event.clipboardData).then((handled) => {
              if (handled) event.preventDefault();
            });
          }}
        >
          <div className="task-create-dialog__body">
            <div className="task-create-dialog__primary">
              <label>
                <FieldCaption
                  label="Title"
                  help="Short outcome shown on the board card."
                />
                <Input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What needs doing?"
                  maxLength={180}
                />
              </label>
              <label className="task-create-dialog__grow">
                <FieldCaption
                  label="Description"
                  help="Required. Context, constraints, expected result, and any proof the worker should return."
                  action={
                    <IconButton
                      type="button"
                      aria-label="Expand description"
                      title="Expand description"
                      disabled={pending}
                      onClick={() => setDescriptionOpen(true)}
                    >
                      <Maximize2 size={12} />
                    </IconButton>
                  }
                />
                <Textarea
                  required
                  value={details}
                  onChange={(event) => {
                    setDetails(event.target.value);
                    if (formError && event.target.value.trim()) setFormError("");
                  }}
                  placeholder="Context, constraints, expected result…"
                  rows={12}
                  aria-invalid={formError === "Description is required."}
                />
              </label>
              <label className="task-create-dialog__grow task-create-dialog__grow--secondary">
                <FieldCaption
                  label="Finish criteria"
                  help="Soft north-star for the agent. Hard gates (artifacts, git) are set on the right."
                />
                <Textarea
                  value={criteriaText}
                  onChange={(event) => setCriteriaText(event.target.value)}
                  placeholder="What must be true when this is done…"
                  rows={6}
                />
              </label>
            </div>

            <aside className="task-create-dialog__aside" aria-label="Details and hard gates">
              <label>
                <FieldCaption
                  label="Role"
                  help="Specialization this work should be routed to."
                />
                <Input
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="e.g. Security Agent"
                  list={roleListId}
                />
                <datalist id={roleListId}>
                  {roles.map((knownRole) => (
                    <option key={knownRole} value={knownRole} />
                  ))}
                </datalist>
              </label>
              <label>
                <FieldCaption
                  label="Depends on"
                  help="Hard prerequisite task ids on this sink or any other task sink in the same region. Empty means free to claim in parallel."
                />
                <Input
                  value={dependsOnText}
                  onChange={(event) => setDependsOnText(event.target.value)}
                  placeholder="task ids (same region)…"
                />
              </label>

              <div className="task-create-dialog__gates">
                <div className="task-create-dialog__gates-heading">
                  <FieldCaption
                    label="Hard finish gates"
                    help="Deterministic complete requirements. Artifacts resolve to the canvas artifacts sink automatically."
                  />
                </div>
                <label
                  className={`task-create-dialog__check${
                    !artifactsNodeId ? " is-disabled" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={requireArtifacts}
                    disabled={!artifactsNodeId}
                    title={
                      artifactsNodeId
                        ? undefined
                        : "No artifacts sink on this canvas"
                    }
                    onChange={(event) => setRequireArtifacts(event.target.checked)}
                  />
                  <span>Require artifact(s)</span>
                </label>
                {requireArtifacts ? (
                  <div className="task-create-dialog__gate-fields">
                    <label>
                      <FieldCaption
                        label="Instruction"
                        help="What the agent should publish to the artifacts sink."
                      />
                      <Textarea
                        value={artifactsInstruction}
                        onChange={(event) => setArtifactsInstruction(event.target.value)}
                        placeholder="What to publish…"
                        rows={2}
                      />
                    </label>
                    <label>
                      <FieldCaption
                        label="Required names"
                        help="Optional exact artifact names that must match on complete."
                      />
                      <Input
                        value={artifactNamesText}
                        onChange={(event) => setArtifactNamesText(event.target.value)}
                        placeholder="exact names…"
                      />
                    </label>
                  </div>
                ) : null}
                <label className="task-create-dialog__check">
                  <input
                    type="checkbox"
                    checked={requireGit}
                    onChange={(event) => setRequireGit(event.target.checked)}
                  />
                  <span>Require at least one git commit</span>
                </label>
              </div>

              <div
                className={`task-create-dialog__media${dragOver ? " is-dragover" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setDragOver(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  void ingestClipboardOrFiles(event.dataTransfer);
                }}
              >
                <div className="task-create-dialog__media-heading">
                  <FieldCaption
                    label="Media"
                    help="Paste, drop, or attach images. Stored as first-class raw parts and projected to remote claims (not host paths)."
                  />
                </div>
                {media.length > 0 ? (
                  <ul className="task-create-dialog__media-list">
                    {media.map((item) => (
                      <li key={item.id}>
                        <img src={item.previewUrl} alt={item.label} />
                        <div>
                          <strong>{item.label}</strong>
                          <span>{item.mediaType}</span>
                        </div>
                        <IconButton
                          aria-label={`Remove ${item.label}`}
                          title="Remove"
                          disabled={pending}
                          onClick={() =>
                            setMedia((current) =>
                              current.filter((entry) => entry.id !== item.id),
                            )
                          }
                        >
                          <X size={12} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="task-create-dialog__media-empty">Paste or drop an image</p>
                )}
                <div className="task-create-dialog__media-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
                    multiple
                    hidden
                    onChange={(event) => {
                      void ingestFileList(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="subtle"
                    disabled={pending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus size={12} />
                    Attach image
                  </Button>
                  {media.length > 0 ? <span>{media.length} attached</span> : null}
                </div>
                {mediaError ? (
                  <p className="task-create-dialog__media-error" role="alert">
                    {mediaError}
                  </p>
                ) : null}
              </div>
            </aside>
          </div>

          {formError ? (
            <p className="task-create-dialog__form-error" role="alert">
              {formError}
            </p>
          ) : null}

          <footer>
            {stayOpen ? (
              <span className="task-create-dialog__stay-hint" aria-live="polite">
                {flash || "Stays open after create"}
              </span>
            ) : (
              <Button type="button" variant="subtle" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={pending || !title.trim()}>
              {pending
                ? isProposal
                  ? "Proposing…"
                  : "Creating…"
                : isProposal
                  ? "Create proposal"
                  : stayOpen
                    ? "Enqueue"
                    : "Create task"}
            </Button>
          </footer>
        </form>
  );

  const header = (
    <OverlayHeader
      eyebrow={isProposal ? "new proposal" : stayOpen ? "quick enqueue" : "new task"}
      title={stayOpen ? "Enqueue to queue" : "Define the work"}
      actions={
        <>
          {headerActions}
          <IconButton
            aria-label={isProposal ? "Close proposal creator" : "Close task creator"}
            title="Close"
            onClick={onClose}
            disabled={pending}
          >
            <X size={14} />
          </IconButton>
        </>
      }
    />
  );

  if (shell === "inline") {
    return (
      <div className="task-create-dialog task-create-dialog--inline" data-testid="task-enqueue-form">
        {header}
        {formBody}
        {descriptionOpen ? (
          <div className="task-description-focus task-description-focus--inline">
            <OverlayHeader
              eyebrow="description"
              title="Task description"
              actions={
                <IconButton
                  aria-label="Close description"
                  title="Close"
                  onClick={() => setDescriptionOpen(false)}
                >
                  <X size={14} />
                </IconButton>
              }
            />
            <div className="task-description-focus__body">
              <Textarea
                autoFocus
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="Context, constraints, expected result…"
                rows={16}
              />
              <footer>
                <Button type="button" variant="primary" onClick={() => setDescriptionOpen(false)}>
                  Done
                </Button>
              </footer>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <FocusSurface
        measure="document"
        height="fit"
        layer="work"
        label={isProposal ? "Create proposal" : "Create task"}
        onClose={onClose}
        closeOnBackdrop={!pending && !descriptionOpen}
        closeOnEscape={!pending && !descriptionOpen}
        panelClassName="task-create-dialog"
      >
        {header}
        {formBody}
      </FocusSurface>

      {descriptionOpen ? (
        <FocusSurface
          measure="document"
          height="fit"
          layer="work"
          label="Task description"
          onClose={() => setDescriptionOpen(false)}
          panelClassName="task-description-focus"
        >
          <OverlayHeader
            eyebrow="description"
            title="Task description"
            actions={
              <IconButton
                aria-label="Close description"
                title="Close"
                onClick={() => setDescriptionOpen(false)}
              >
                <X size={14} />
              </IconButton>
            }
          />
          <div className="task-description-focus__body">
            <Textarea
              autoFocus
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="Context, constraints, expected result…"
              rows={22}
            />
            <footer>
              <Button type="button" variant="primary" onClick={() => setDescriptionOpen(false)}>
                Done
              </Button>
            </footer>
          </div>
        </FocusSurface>
      ) : null}
    </>
  );
}

export { resolveArtifactsNodeId };

function TaskDetailPanel({
  task,
  pending,
  claimantRetired,
  isProposal,
  proposedBy,
  onClose,
  onSaveTitle,
  onRespond,
  onReject,
  onMove,
  onApprove,
  onRejectProposal,
}: {
  readonly task: WorkTask;
  readonly pending: boolean;
  readonly claimantRetired: boolean;
  readonly isProposal: boolean;
  readonly proposedBy?: string;
  readonly onClose: () => void;
  readonly onSaveTitle: (task: WorkTask, title: string) => void;
  readonly onRespond: (
    task: WorkTask,
    response: string,
    disposition: "working" | "rejected",
  ) => Promise<boolean>;
  readonly onReject: (task: WorkTask, comment: string) => Promise<boolean>;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onApprove?: (task: WorkTask) => void;
  readonly onRejectProposal?: (task: WorkTask) => void;
}) {
  const [title, setTitle] = useState(() => taskTitle(task));
  const [response, setResponse] = useState("");
  const [rejectionComment, setRejectionComment] = useState("");
  const role = taskRole(task);
  const claim = claimedByOf(task);
  const details = taskDetails(task);
  const legacyMedia = taskMediaParts(task);
  const contentMedia = taskContentParts(task);
  const attentionRequired =
    !isProposal && (task.state === "input-required" || task.state === "auth-required");
  const requestContext = latestText(task);
  const hardFinishGate =
    task.finishCriteria?.artifacts !== undefined ||
    task.finishCriteria?.git !== undefined;
  const rejectedTimes =
    typeof task.metadata?.rejectedTimes === "number" &&
    Number.isSafeInteger(task.metadata.rejectedTimes) &&
    task.metadata.rejectedTimes > 0
      ? task.metadata.rejectedTimes
      : undefined;
  const transitionOptions = isProposal
    ? []
    : [
        ...LANES.flatMap((lane) =>
          lane.state &&
          !(task.state === "completed" && lane.state === "submitted") &&
          canTransitionTaskState(task.state, lane.state)
            ? [{ value: lane.state, label: `Move to ${lane.label}` }]
            : [],
        ),
        ...(
          [
            ["completed", "Complete task"],
            ["failed", "Mark as failed"],
            ["rejected", "Reject task"],
            ["canceled", "Cancel task"],
            ["archived", "Delete from board"],
          ] as const
        ).flatMap(([state, label]) =>
          canTransitionTaskState(task.state, state) &&
          !LANES.some((lane) => lane.state === state) &&
          !(state === "completed" && hardFinishGate)
            ? [{ value: state, label }]
            : [],
        ),
      ];
  const proposedByLabel =
    proposedBy === undefined
      ? undefined
      : proposedBy === "operator"
        ? "Proposed by operator"
        : `Proposed by ${proposedBy}`;

  return (
    <aside className="task-detail-panel" aria-label={`Details for ${taskTitle(task)}`}>
      <header className="task-detail-panel__header">
        <div>
          <div className="task-detail-panel__chips">
            <Chip tone={isProposal ? "violet" : chipToneForState(task.state)}>
              {isProposal ? "Proposed" : stateLabel(task.state)}
            </Chip>
            {claimantRetired ? (
              <Chip
                tone="crimson"
                title="This task remains claimed, but its ActorSeatId is absent from the current actor projection."
              >
                Stalled · retired seat
              </Chip>
            ) : null}
            {isProposal && onApprove ? (
              <Button
                size="xs"
                variant="primary"
                disabled={pending}
                title="Approve this proposal into the Queue for workers"
                onClick={() => onApprove(task)}
              >
                <CheckCircle2 size={12} />
                Approve to Queue
              </Button>
            ) : null}
            {isProposal && onRejectProposal ? (
              <Button
                size="xs"
                variant="danger"
                disabled={pending}
                title="Reject and remove this proposal from the board"
                onClick={() => onRejectProposal(task)}
              >
                <XCircle size={12} />
                Reject proposal
              </Button>
            ) : null}
            {!isProposal && canTransitionTaskState(task.state, "archived") ? (
              <Button
                size="xs"
                variant="danger"
                disabled={pending}
                title="Soft-delete: remove this task from the board entirely"
                data-testid="task-delete-from-board"
                onClick={() => onMove(task, "archived")}
              >
                <XCircle size={12} />
                Delete from board
              </Button>
            ) : null}
            {!isProposal &&
            task.state !== "completed" &&
            claim &&
            canTransitionTaskState(task.state, "submitted") ? (
              <Button
                size="xs"
                variant="subtle"
                disabled={pending}
                title="Clear this claim and return the task to Queue"
                onClick={() => onMove(task, "submitted")}
              >
                <RotateCcw size={12} />
                Unclaim to Queue
              </Button>
            ) : null}
          </div>
          <h2>{taskTitle(task)}</h2>
        </div>
        <IconButton aria-label="Close task details" title="Close details" onClick={onClose}>
          <PanelRightClose size={15} />
        </IconButton>
      </header>

      <div className="task-detail-panel__identity">
        <span title={isProposal ? "Proposal ID" : "Task ID"}>#{task.id}</span>
        <span className="task-detail-panel__claim" title={isProposal ? proposedBy : claim}>
          <UserRound size={12} aria-hidden />
          {isProposal ? (proposedByLabel ?? "Proposed") : (claim ?? "Unclaimed")}
        </span>
        <span>{role ?? "No task role"}</span>
        {rejectedTimes !== undefined ? (
          <span title="Times returned to Queue after QA rejection">
            QA rejects: {rejectedTimes}
          </span>
        ) : null}
      </div>

      <div className="task-detail-panel__scroll">
        {attentionRequired ? (
          <section
            className="task-detail-panel__attention is-input"
            aria-labelledby={`task-response-${task.id}`}
          >
            <div className="task-detail-panel__attention-heading">
              <span className="task-detail-panel__attention-icon" aria-hidden>
                <MessageSquareWarning size={15} />
              </span>
              <div>
                <p>Operator response</p>
                <h3 id={`task-response-${task.id}`}>Input required</h3>
              </div>
            </div>

            <div className="task-detail-panel__request-context">
              <span>Worker is waiting on</span>
              <p>
                {requestContext ??
                  "The worker asked for more context before continuing."}
              </p>
            </div>

            <label className="task-detail-panel__response-field">
              <span>Your response</span>
              <Textarea
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                placeholder="Give the worker the context, decision, or answer needed to continue…"
                rows={5}
              />
            </label>

            <div className="task-detail-panel__response-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !response.trim()}
                onClick={async () => {
                  if (await onRespond(task, response.trim(), "working")) setResponse("");
                }}
              >
                <Reply size={13} />
                Send input &amp; resume
              </Button>
            </div>

          </section>
        ) : null}

        <section className="task-detail-panel__section">
          <h3>Title</h3>
          {isProposal ? (
            <p className="task-detail-panel__description">{taskTitle(task)}</p>
          ) : (
            <form
              className="task-detail-panel__title-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim() && title.trim() !== taskTitle(task)) onSaveTitle(task, title.trim());
              }}
            >
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              <Button
                type="submit"
                size="xs"
                variant="subtle"
                disabled={pending || !title.trim() || title.trim() === taskTitle(task)}
              >
                Save title
              </Button>
            </form>
          )}
        </section>

        <section className="task-detail-panel__section">
          <h3>Description</h3>
          {details ? (
            <p className="task-detail-panel__description">{details}</p>
          ) : (
            <p className="task-detail-panel__empty">No long-form description was provided.</p>
          )}
        </section>

        {task.reason ? (
          <section className="task-detail-panel__section">
            <h3>Reason</h3>
            <p className="task-detail-panel__description">{task.reason}</p>
          </section>
        ) : null}

        {task.dependsOn && task.dependsOn.length > 0 ? (
          <section className="task-detail-panel__section">
            <h3>Depends on</h3>
            <p className="task-detail-panel__description">
              {task.dependsOn.join(", ")}
            </p>
          </section>
        ) : null}

        {task.finishCriteria ? (
          <section className="task-detail-panel__section">
            <h3>Finish criteria</h3>
            {task.finishCriteria.description ? (
              <p className="task-detail-panel__description">{task.finishCriteria.description}</p>
            ) : null}
            {task.finishCriteria.artifacts ? (
              <p className="task-detail-panel__description">
                Artifacts required on node{" "}
                <code>{task.finishCriteria.artifacts.nodeId}</code>
                {task.finishCriteria.artifacts.instruction
                  ? ` — ${task.finishCriteria.artifacts.instruction}`
                  : ""}
                {task.finishCriteria.artifacts.names &&
                task.finishCriteria.artifacts.names.length > 0
                  ? ` · names: ${task.finishCriteria.artifacts.names.join(", ")}`
                  : ""}
              </p>
            ) : null}
            {task.finishCriteria.git ? (
              <p className="task-detail-panel__description">
                Git: ≥ {task.finishCriteria.git.minCommits} commit(s)
              </p>
            ) : null}
            {(task.finishCriteria.artifacts || task.finishCriteria.git) &&
            task.state !== "completed" ? (
              <p className="task-detail-panel__empty">
                Complete via agent/CLI with{" "}
                <code>completionEvidence</code> (artifacts and/or git commits).
                Board Complete is disabled while hard criteria are set.
              </p>
            ) : null}
          </section>
        ) : null}

        {task.completionEvidence ? (
          <section className="task-detail-panel__section">
            <h3>Completion evidence</h3>
            {task.completionEvidence.artifacts.length > 0 ? (
              <p className="task-detail-panel__description">
                Artifacts:{" "}
                {task.completionEvidence.artifacts
                  .map((a) => `${a.artifactId} @ ${a.nodeId}`)
                  .join("; ")}
              </p>
            ) : null}
            {task.completionEvidence.git?.commits &&
            task.completionEvidence.git.commits.length > 0 ? (
              <p className="task-detail-panel__description">
                Commits: {task.completionEvidence.git.commits.join(", ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {contentMedia.length > 0 || legacyMedia.length > 0 ? (
          <section className="task-detail-panel__section">
            <h3>
              <Paperclip size={13} aria-hidden />
              Media
            </h3>
            <ul className="task-detail-panel__media">
              {contentMedia.map((part, index) => (
                <li key={`content-${part.ref.sha256}-${index}`}>
                  <ContentMedia
                    contentRef={part.ref}
                    alt={`Task attachment ${index + 1}`}
                  />
                </li>
              ))}
              {legacyMedia.map((part, index) => (
                <li key={`legacy-${part.mediaType ?? "raw"}-${index}`}>
                  <img
                    src={`data:${part.mediaType};base64,${part.bytesBase64}`}
                    alt={`Task attachment ${index + 1}`}
                  />
                  <span>{part.mediaType ?? "image"}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {!isProposal && task.state === "completed" ? (
          <section
            className="task-detail-panel__attention is-rejection"
            aria-labelledby={`task-rejection-${task.id}`}
          >
            <div className="task-detail-panel__attention-heading">
              <span className="task-detail-panel__attention-icon" aria-hidden>
                <MessageSquareWarning size={15} />
              </span>
              <div>
                <p>QA review</p>
                <h3 id={`task-rejection-${task.id}`}>Reject and re-enqueue</h3>
              </div>
            </div>
            <p className="task-detail-panel__description">
              If the completed work does not prove the finish criteria, leave a
              comment. The task will return to Queue and the comment will stay in
              Activity for the next worker.
            </p>
            <label className="task-detail-panel__response-field">
              <span>QA rejection comment</span>
              <Textarea
                aria-label="QA rejection comment"
                value={rejectionComment}
                onChange={(event) => setRejectionComment(event.target.value)}
                placeholder="What still needs to be fixed or proven?"
                rows={5}
              />
            </label>
            <div className="task-detail-panel__response-actions">
              <Button
                size="sm"
                variant="danger"
                data-testid="task-reject-reenqueue"
                aria-label="Reject and re-enqueue task"
                disabled={pending || !rejectionComment.trim()}
                onClick={async () => {
                  if (await onReject(task, rejectionComment.trim())) {
                    setRejectionComment("");
                  }
                }}
              >
                <RotateCcw size={13} />
                Reject &amp; re-enqueue
              </Button>
            </div>
          </section>
        ) : null}

        <section className="task-detail-panel__section">
          <h3>
            <Activity size={13} aria-hidden />
            Activity
          </h3>
          <ol className="task-detail-panel__activity">
            {task.history.slice(1).length > 0 ? (
              task.history.slice(1).map((message) => (
                <li key={message.messageId}>
                  <div>
                    <div className="task-detail-panel__activity-actor">
                      <StatusDot tone={message.role === "agent" ? "cyan" : "amber"} />
                      <strong>{message.role === "agent" ? claim ?? "Agent" : "Operator"}</strong>
                    </div>
                    <p>
                      {message.parts
                        .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
                        .map((part) => part.text)
                        .join(" ") || "Attached structured context."}
                    </p>
                  </div>
                </li>
              ))
            ) : (
              <li className="task-detail-panel__empty">No activity yet.</li>
            )}
          </ol>
        </section>

        {isProposal ? (
          <section className="task-detail-panel__section task-detail-panel__status">
            <div>
              <h3>Planning</h3>
              <p>
                Proposals are drafts. Approve to mint a queued task workers can claim,
                reject to discard it, or leave it here until the plan is ready.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {onApprove ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending}
                  onClick={() => onApprove(task)}
                >
                  <CheckCircle2 size={13} />
                  Approve to Queue
                </Button>
              ) : null}
              {onRejectProposal ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() => onRejectProposal(task)}
                >
                  <XCircle size={13} />
                  Reject proposal
                </Button>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="task-detail-panel__section task-detail-panel__status">
            <div>
              <h3>{attentionRequired ? "Other status changes" : "Status"}</h3>
              <p>
                {task.state === "completed"
                  ? "Completed work can return to Queue only through the QA review above, or be deleted from the board entirely."
                  : attentionRequired
                  ? "Use this only when the task should leave the response workflow without resuming."
                  : "Move this task to another valid stage, or delete it from the board (soft-archive)."}
              </p>
            </div>
            {task.state === "completed" &&
            !canTransitionTaskState(task.state, "archived") ? null : (
              <Dropdown
                value=""
                options={transitionOptions}
                disabled={pending || transitionOptions.length === 0}
                aria-label="Change task status"
                placeholder={
                  transitionOptions.length > 0 ? "Choose a status…" : "No available transitions"
                }
                onChange={(state) => onMove(task, state as TaskState)}
                className="task-detail-panel__status-menu"
                triggerClassName="h-9 w-full rounded-[5px] border border-white/10 bg-white/[0.04] px-3 text-[10px] uppercase tracking-[0.08em]"
                align="start"
              />
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

export function TaskBoard({
  node,
  onClose,
  initialItemId,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
  /** Pre-select this task when opened from jump-to-cause. */
  readonly initialItemId?: string;
}) {
  const items = node.ether?.tasks?.items ?? [];
  const proposals = node.ether?.tasks?.proposals ?? [];
  const proposalTasks = useMemo(
    () =>
      proposals
        .filter((proposal) => proposal.state === "pending")
        .map(proposalAsDisplayTask),
    [proposals],
  );
  const proposalById = useMemo(
    () =>
      new Map(
        proposals.map((proposal) => [
          proposal.id,
          proposal.proposedBy.nodeId,
        ]),
      ),
    [proposals],
  );
  const glance = sinkGlance(items);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hideClosed, setHideClosed] = useState(false);
  const [creating, setCreating] = useState<CreateDialogMode | null>(null);
  const [creatingPending, setCreatingPending] = useState(false);
  const [roleDraft, setRoleDraft] = useState(workRoleOf(node) ?? "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeLane, setActiveLane] = useState<LaneId | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    if (
      initialItemId &&
      (items.some((task) => task.id === initialItemId) ||
        proposals.some(
          (proposal) => proposal.state === "pending" && proposal.id === initialItemId,
        ))
    ) {
      return initialItemId;
    }
    return null;
  });
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const api = getVellumApi();
  const name = canvasName();
  const actorRefs = use$(state$.actorRefs);
  const activeActorSeatIds = useMemo(
    () => new Set<string>(actorRefs.map((actor) => actor.seatId)),
    [actorRefs],
  );

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((task) => {
      const claim = claimedByOf(task)?.toLowerCase() ?? "";
      return (
        taskTitle(task).toLowerCase().includes(normalized) ||
        Boolean(taskDetails(task)?.toLowerCase().includes(normalized)) ||
        Boolean(taskRole(task)?.toLowerCase().includes(normalized)) ||
        claim.includes(normalized)
      );
    });
  }, [items, query]);

  const tasksByLane = useMemo(() => {
    const grouped: Record<LaneId, WorkTask[]> = {
      proposal: [],
      queue: [],
      working: [],
      input: [],
      closed: [],
    };
    grouped.proposal.push(
      ...proposalTasks.filter((task) => {
        const normalized = query.trim().toLowerCase();
        return !normalized ||
          taskTitle(task).toLowerCase().includes(normalized) ||
          Boolean(taskDetails(task)?.toLowerCase().includes(normalized));
      }),
    );
    for (const task of visibleItems) grouped[laneForTask(task)].push(task);
    return grouped;
  }, [proposalTasks, query, visibleItems]);

  const activeTask = activeTaskId ? items.find((task) => task.id === activeTaskId) : undefined;
  // Proposals are display-mapped WorkTasks (not in items) — resolve both lists so
  // clicking a proposal opens the same detail panel as a normal task.
  const selectedTask = selectedTaskId
    ? (items.find((task) => task.id === selectedTaskId) ??
      proposalTasks.find((task) => task.id === selectedTaskId))
    : undefined;
  const selectedIsProposal =
    selectedTask !== undefined && proposalById.has(selectedTask.id);
  const doc = use$(state$.doc);
  const knownRoles = useMemo(() => workRolesInDoc(doc), [doc]);
  /** Region-scoped tasks for dep glance (cross-sink prereqs in the same region). */
  const scopeTasks = useMemo(
    () => dependencyScopeTasks(doc, node.id),
    [doc, node.id],
  );

  const createTask = async (
    title: string,
    details: string,
    role: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string> = [],
    finishCriteria?: import("@shared/work-model").FinishCriteria,
  ) => {
    if (!api || !title.trim() || !details.trim()) return;
    setError("");
    setCreatingPending(true);
    try {
      const metadata: WorkMetadata = {
        title: title.trim(),
        details: details.trim(),
        ...(role.trim() ? { workRole: role.trim() } : {}),
      };
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskCreate(
          name,
          node.id,
          title.trim(),
          metadata,
          undefined,
          media.length > 0 ? media : undefined,
          dependsOn.length > 0 ? dependsOn : undefined,
          finishCriteria,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(`Created ${title.trim()} in Queue.`);
      setCreating(null);
      setSelectedTaskId(result.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingPending(false);
    }
  };

  const createProposal = async (
    title: string,
    details: string,
    role: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string> = [],
    finishCriteria?: import("@shared/work-model").FinishCriteria,
  ) => {
    if (!api || !title.trim() || !details.trim()) return;
    setError("");
    setCreatingPending(true);
    try {
      const metadata: WorkMetadata = {
        title: title.trim(),
        details: details.trim(),
        ...(role.trim() ? { workRole: role.trim() } : {}),
      };
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskPropose(
          name,
          node.id,
          title.trim(),
          metadata,
          undefined,
          media.length > 0 ? media : undefined,
          dependsOn.length > 0 ? dependsOn : undefined,
          finishCriteria,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(`Proposed ${title.trim()} for planning.`);
      setCreating(null);
      setSelectedTaskId(result.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingPending(false);
    }
  };

  const transitionTask = async (
    task: WorkTask,
    state: TaskState,
    note?: string,
  ): Promise<boolean> => {
    if (!api || task.state === state) return false;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskTransition(name, node.id, task.id, state, note),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not move ${taskTitle(task)}. ${result.message}`);
        return false;
      }
      if (task.state === "completed" && state === "submitted") {
        setAnnouncement(`Rejected ${taskTitle(task)} and returned it to Queue.`);
      } else if (state === "archived") {
        setSelectedTaskId(null);
        setAnnouncement(`Deleted ${taskTitle(task)} from the board.`);
      } else {
        setAnnouncement(`Moved ${taskTitle(task)} to ${stateLabel(state)}.`);
      }
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not move ${taskTitle(task)}. ${message}`);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  const rejectCompletedTask = async (
    task: WorkTask,
    comment: string,
  ): Promise<boolean> => {
    if (task.state !== "completed" || !comment.trim()) return false;
    return transitionTask(task, "submitted", comment.trim());
  };

  const approveProposal = async (task: WorkTask) => {
    if (!api) return;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskApproveProposal(name, node.id, task.id),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not approve ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setAnnouncement(`Approved ${taskTitle(task)} to Queue.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not approve ${taskTitle(task)}. ${message}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  const rejectProposal = async (task: WorkTask) => {
    if (!api?.workTaskRejectProposal) return;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskRejectProposal(name, node.id, task.id),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not reject ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setSelectedTaskId(null);
      setAnnouncement(`Rejected proposal ${taskTitle(task)}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not reject ${taskTitle(task)}. ${message}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  const saveTaskTitle = async (task: WorkTask, nextBrief: string) => {
    const describe = (api as (typeof api & DescribeApi) | undefined)?.workTaskDescribe;
    if (!api || !describe || !nextBrief.trim()) {
      setError("Task editing is not available until the current work service is ready.");
      return;
    }
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        describe(name, node.id, task.id, nextBrief.trim()),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEditingTaskId(null);
      setAnnouncement(`Renamed task to ${nextBrief.trim()}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingTaskId(null);
    }
  };

  const respondToTask = async (
    task: WorkTask,
    responseText: string,
    disposition: "working" | "rejected",
  ): Promise<boolean> => {
    if (!api || !responseText.trim()) return false;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskRespond(name, node.id, task.id, responseText.trim(), disposition),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not respond to ${taskTitle(task)}. ${result.message}`);
        return false;
      }
      setAnnouncement(
        disposition === "working"
          ? `Responded to ${taskTitle(task)} and returned it to Working.`
          : `Recorded the decision and moved ${taskTitle(task)} to Rejected.`,
      );
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not respond to ${taskTitle(task)}. ${message}`);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  const onDragStart = (event: DragStartEvent) => {
    const data = event.operation.source?.data as BoardDragData | undefined;
    if (data?.kind !== "task") return;
    setActiveTaskId(data.taskId);
    setActiveLane(data.laneId);
    const task = items.find((item) => item.id === data.taskId);
    if (task) {
      setAnnouncement(
        `Picked up ${taskTitle(task)} from ${LANES.find((lane) => lane.id === data.laneId)?.label}.`,
      );
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const source = event.operation.source?.data as BoardDragData | undefined;
    const target = event.operation.target?.data as BoardDragData | undefined;
    setActiveTaskId(null);
    setActiveLane(null);
    if (event.canceled || source?.kind !== "task" || !target) return;

    const task = items.find((item) => item.id === source.taskId);
    const targetLane = target.laneId;
    if (!task || source.laneId === targetLane) return;
    const state = destinationState(targetLane);
    if (!state) {
      setAnnouncement("Use the task actions menu to choose how this task should close.");
      return;
    }
    void transitionTask(task, state);
  };

  const shownLanes = hideClosed ? LANES.filter((lane) => lane.id !== "closed") : LANES;

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Task flow"
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="task-board-surface nowheel"
    >
      <DragDropProvider<BoardDragData>
        onDragStart={onDragStart}
        onDragOver={(event) => {
          const target = event.operation.target?.data as BoardDragData | undefined;
          setActiveLane(target?.laneId ?? null);
        }}
        onDragEnd={onDragEnd}
      >
        <OverlayHeader
          eyebrow="tasks"
          title="Task flow"
          status={
            <>
              {glance.inFlight} in flight
              {glance.needsInput > 0 ? ` · ${glance.needsInput} need you` : ""}
            </>
          }
          actions={
            <>
              <label className="task-board-role">
                <span>Work role</span>
                <Input
                  aria-label="Queue work role"
                  placeholder="Any role"
                  value={roleDraft}
                  onChange={(event) => setRoleDraft(event.target.value)}
                  onBlur={() => setNodeWorkRole(node.id, roleDraft.trim() || undefined)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setNodeWorkRole(node.id, roleDraft.trim() || undefined);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <IconButton
                tone={searchOpen ? "accent" : "default"}
                aria-label={searchOpen ? "Close task search" : "Search tasks"}
                title="Search tasks"
                onClick={() => {
                  setSearchOpen((open) => !open);
                  if (searchOpen) setQuery("");
                }}
              >
                <Search size={14} />
              </IconButton>
              <IconButton
                tone={hideClosed ? "accent" : "default"}
                aria-label={hideClosed ? "Show closed tasks" : "Hide closed tasks"}
                title={hideClosed ? "Show closed tasks" : "Hide closed tasks"}
                onClick={() => setHideClosed((hidden) => !hidden)}
              >
                <Filter size={14} />
              </IconButton>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setCreating("proposal")}
              >
                <Plus size={12} />
                New proposal
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreating("task")}
                data-testid="task-board-enqueue"
              >
                <Plus size={12} />
                Enqueue
              </Button>
              <IconButton aria-label="Close task flow" title="Close" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </>
          }
        />

        {searchOpen ? (
          <div className="task-board-search">
            <Search size={13} aria-hidden />
            <Input
              aria-label="Search task titles and workers"
              placeholder="Search task titles and workers"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")}>
                Clear search
              </button>
            ) : null}
          </div>
        ) : null}

        {creating ? (
          <TaskCreateDialog
            mode={creating}
            roles={knownRoles}
            pending={creatingPending}
            artifactsNodeId={resolveArtifactsNodeId(node.id, doc)}
            onClose={() => {
              if (!creatingPending) setCreating(null);
            }}
            onCreate={(title, details, role, media, dependsOn, finishCriteria) => {
              if (creating === "proposal") {
                void createProposal(
                  title,
                  details,
                  role,
                  media,
                  dependsOn,
                  finishCriteria,
                );
                return;
              }
              void createTask(title, details, role, media, dependsOn, finishCriteria);
            }}
          />
        ) : null}

        {error ? (
          <div className="task-board-error" role="alert">
            <MessageSquareWarning size={14} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="task-board-workspace" data-detail-open={selectedTask ? "true" : "false"}>
          <div
            className="task-board-grid"
            style={{ ["--task-board-lanes" as string]: shownLanes.length }}
            data-lane-count={shownLanes.length}
            data-testid="task-board"
          >
            {shownLanes.map((lane) => (
              <TaskLane
                key={lane.id}
                lane={lane}
                tasks={tasksByLane[lane.id]}
                allTasks={scopeTasks}
                searchActive={Boolean(query.trim())}
                activeLane={activeLane}
                pendingTaskId={pendingTaskId}
                editingTaskId={editingTaskId}
                selectedTaskId={selectedTaskId}
                activeActorSeatIds={activeActorSeatIds}
                proposalById={proposalById}
                onCreate={() =>
                  setCreating(lane.id === "proposal" ? "proposal" : "task")
                }
                onSelect={setSelectedTaskId}
                onMove={(task, state) => void transitionTask(task, state)}
                onApprove={(task) => void approveProposal(task)}
                onRejectProposal={(task) => void rejectProposal(task)}
                onEdit={(task) => setEditingTaskId(task.id)}
                onCancelEdit={() => setEditingTaskId(null)}
                onSaveEdit={(task, nextBrief) => void saveTaskTitle(task, nextBrief)}
              />
            ))}
          </div>
          {selectedTask ? (
            <TaskDetailPanel
              key={selectedTask.id}
              task={selectedTask}
              pending={pendingTaskId === selectedTask.id}
              claimantRetired={
                selectedIsProposal
                  ? false
                  : isTaskClaimantRetired(
                      selectedTask.state,
                      claimedByOf(selectedTask),
                      activeActorSeatIds,
                    )
              }
              isProposal={selectedIsProposal}
              proposedBy={proposalById.get(selectedTask.id)}
              onClose={() => setSelectedTaskId(null)}
              onSaveTitle={(task, title) => void saveTaskTitle(task, title)}
              onRespond={respondToTask}
              onReject={rejectCompletedTask}
              onMove={(task, state) => void transitionTask(task, state)}
              onApprove={
                selectedIsProposal
                  ? (task) => void approveProposal(task)
                  : undefined
              }
              onRejectProposal={
                selectedIsProposal
                  ? (task) => void rejectProposal(task)
                  : undefined
              }
            />
          ) : null}
        </div>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>
          {activeTask ? <DragCardPreview task={activeTask} /> : null}
        </DragOverlay>
      </DragDropProvider>
    </FocusSurface>
  );
}
