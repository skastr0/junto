import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ArrowDownToLine,
  ArrowUpRight,
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
  Settings2,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import {
  applyTaskBoardSelection,
  columnSelectionState,
  resolveTaskBoardBulkActions,
  toggleSelectAllInColumn,
  type TaskBoardBulkAction,
  type TaskBoardSelectMode,
} from "./task-board-selection";
import {
  DragDropProvider,
  DragOverlay,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type {
  CanvasDoc,
  CanvasNode,
  CompletionEvidence,
  Part,
  TaskState,
  WorkMetadata,
} from "@shared/canvas";
import type { TaskCreateOptions, WorkOpResult } from "@shared/ipc";
import { sinkGlance } from "@shared/attention";
import {
  canTransitionTaskState,
  claimedByOf,
  compareTasksByLatestActivityDesc,
  taskBrief,
  taskContentParts,
  taskMediaParts,
  validateTaskMediaParts,
} from "@shared/task";
import { ContentMedia } from "./ContentMedia";
import { TaskVisits } from "./TaskVisits";
import { TaskThread } from "./TaskThread";
import { RequiresReviewControl } from "./RequiresReviewControl";
import { VerdictChain } from "./VerdictChain";
import {
  reviewGateOf,
  reviewsEdgeHoldsVerdictPost,
  verdictsOnTask,
} from "../../lib/crew-review-view";
import { ApprovalMark, OutgoingGroupHeader } from "./TaskPathMarks";
import { TaskCreationPath } from "../rules/creation";
import { PinRulingControl, BoardSettings } from "../rules";
import { formatWait } from "../rules/board-settings";
import { admissionLabel } from "../../lib/admission-labels";
import {
  TaskOperatorPanel,
  type RuleSubmission,
} from "./TaskOperatorPanel";
import { rulesInForce } from "@shared/rules";
import { defectTargetOptions } from "@shared/visit-integrity";
import { reachableBoards } from "@shared/flow-graph";
import {
  resolveTaskAdmission,
  type TaskAdmission,
  type TaskRule,
  type TasksContract,
} from "@shared/work-model";
import { currentTaskOwner } from "@shared/task-owner";
import {
  admissionLaneHint,
  incomingGlance,
  groupOutgoingVisits,
  hasPendingWait,
  taskNeedsApproval,
  taskPathLaneCopy,
  taskPathShape,
  type OutgoingGroupKind,
  type TaskPathShape,
} from "./task-path";
import { dependencyScopeTasks } from "@shared/task-dep-scope";
import {
  taskDepStatus,
  taskIndexById,
  type TaskDepStatus,
} from "@shared/task-deps";
import { FocusSurface } from "../FocusSurface";
import { nodeTitle } from "../../lib/presentation";
import { Button } from "../ui/Button";
import { Chip, type ChipTone } from "../ui/Chip";
import { Dropdown } from "../ui/Dropdown";
import { IconButton } from "../ui/IconButton";
import { Input, Textarea } from "../ui/Field";
import { OverlayHeader } from "../ui/OverlayHeader";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { tasksNodeIdentity, tasksNodeName } from "@shared/tasks-node-identity";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import {
  extractClipboardImage,
  fileToClipboardImage,
  type ClipboardImage,
} from "../../lib/clipboard-image";
import { state$ } from "../../lib/state";
import { getJuntoApi } from "../../lib/junto-api";
import {
  defaultTaskAdmission,
  parseTaskWait,
  taskAdmissionChoices,
} from "./task-create-admission";
import "./task-board.css";
import { claimFocusOnMount } from "../../lib/focus-ownership";

/** Prefer Artifacts nodes edge-linked to the Tasks node; else first on canvas. */
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
  image: ClipboardImage,
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

type LaneId =
  | "queue"
  | "incoming"
  | "working"
  | "input"
  | "outgoing"
  | "closed";

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
    id: "queue",
    label: "Queue",
    state: "submitted",
    tone: "amber",
    chipTone: "amber",
    icon: CircleDot,
    hint: "Ready to claim",
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
    hint: "Finished or stopped work",
  },
];

/**
 * Path columns. Incoming collects work entering this board; Outgoing collects
 * work sent to the next board. A board with no path edges uses the standard
 * board columns instead.
 */
const INCOMING_LANE: LaneDefinition = {
  id: "incoming",
  label: "Incoming",
  state: "submitted",
  tone: "amber",
  chipTone: "amber",
  icon: ArrowDownToLine,
  hint: "Tasks from earlier boards, waiting here",
};

const OUTGOING_LANE: LaneDefinition = {
  id: "outgoing",
  label: "Sent on",
  tone: "green",
  chipTone: "green",
  icon: ArrowUpRight,
  hint: "",
};

const ALL_LANES: ReadonlyArray<LaneDefinition> = [
  ...LANES,
  INCOMING_LANE,
  OUTGOING_LANE,
];

const laneById = (id: LaneId): LaneDefinition =>
  ALL_LANES.find((lane) => lane.id === id)!;

/** The columns this board shows, in order. */
export const visibleLanes = (
  shape: TaskPathShape,
): ReadonlyArray<LaneDefinition> => [
  shape.hasIncoming ? INCOMING_LANE : laneById("queue"),
  laneById("working"),
  laneById("input"),
  shape.hasOutgoing ? OUTGOING_LANE : laneById("closed"),
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

const laneForTask = (
  task: WorkTask,
  shape: TaskPathShape,
  _contract: import("@shared/work-model").TasksContract | undefined,
  _nowMs: number,
): LaneId => {
  if (TERMINAL_STATES.has(task.state)) return shape.hasOutgoing ? "outgoing" : "closed";
  if (task.state === "working") return "working";
  // input-required and residual durable auth-required share one attention lane
  if (task.state === "input-required" || task.state === "auth-required") return "input";
  if (task.state === "submitted") {
    if (shape.hasIncoming) return "incoming";
  }
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

const depGlance = (
  status: TaskDepStatus,
): { readonly label: string; readonly tone: ChipTone } | undefined => {
  switch (status.kind) {
    case "ready":
      return undefined;
    case "waiting":
      return {
        label: `Waiting - ${status.frontier.join(", ")}`,
        tone: "amber",
      };
    case "blocked":
      return {
        label: `Blocked - ${status.roots.join(", ")}`,
        tone: "crimson",
      };
    case "orphan":
      return {
        label: `Missing - ${status.missing.join(", ")}`,
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

const targetState = (laneId: LaneId): TaskState | undefined =>
  ALL_LANES.find((lane) => lane.id === laneId)?.state;

/** One visit group inside the Outgoing column. */
type TaskLaneGroup = {
  readonly key: string;
  readonly kind: OutgoingGroupKind;
  /** Board name for sent-on/sent-back groups. */
  readonly board?: string;
  readonly tasks: ReadonlyArray<WorkTask>;
};

function TaskLane({
  lane,
  lanes,
  tasks,
  groups,
  headerDetail,
  headerAction,
  emptyText,
  markFor,
  needsApprovalFor,
  allTasks,
  searchActive,
  activeLane,
  pendingTaskId,
  editingTaskId,
  selectedTaskId,
  selectedTaskIds,
  activeActorSeatIds,
  ownerFor,
  onCreate,
  onApprove,
  onSelect,
  onToggleSelect,
  onSelectAllInLane,
  onMove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly lane: LaneDefinition;
  /** The columns this board shows — the move menu offers only these. */
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly tasks: ReadonlyArray<WorkTask>;
  /** Outgoing only: the same tasks, bucketed by where each visit went. */
  readonly groups?: ReadonlyArray<TaskLaneGroup>;
  /** Read-only contract facts shown directly under the column title. */
  readonly headerDetail?: ReactNode;
  /** Side-specific contract entry point rendered in the column header. */
  readonly headerAction?: ReactNode;
  /** Teaching copy for an empty column. */
  readonly emptyText?: string;
  /** Queue and Incoming: the task's admission mark. */
  readonly markFor?: (task: WorkTask) => ReactNode;
  readonly needsApprovalFor?: (task: WorkTask) => boolean;
  readonly allTasks: ReadonlyArray<WorkTask>;
  readonly searchActive: boolean;
  readonly activeLane: LaneId | null;
  readonly pendingTaskId: string | null;
  readonly editingTaskId: string | null;
  readonly selectedTaskId: string | null;
  readonly selectedTaskIds: ReadonlySet<string>;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly ownerFor: (task: WorkTask) => string | undefined;
  readonly onCreate: () => void;
  readonly onApprove: (task: WorkTask) => void;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleSelect: (taskId: string) => void;
  readonly onSelectAllInLane: () => void;
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
  const columnIds = tasks.map((task) => task.id);
  const selectState = columnSelectionState(selectedTaskIds, columnIds);
  const selectAllLabel =
    selectState === "all"
      ? `Deselect all ${lane.label.toLowerCase()}`
      : `Select all ${tasks.length} in ${lane.label}`;
  // Add Task keeps its column entry wherever tasks enter — Queue on a plain
  // board, Incoming on a board with incoming flow.
  const createsTasks = lane.id === "queue" || lane.id === "incoming";
  // Cards carry a lane-wide sortable index; the Outgoing groups render the
  // same sequence, so the counter runs across buckets.
  let cardIndex = 0;
  const renderCard = (task: WorkTask) => {
    const index = cardIndex;
    cardIndex += 1;
    return (
      <TaskCard
        key={task.id}
        task={task}
        allTasks={allTasks}
        lane={lane}
        lanes={lanes}
        index={index}
        mark={markFor?.(task)}
        needsApproval={needsApprovalFor?.(task) ?? false}
        pending={pendingTaskId === task.id}
        editing={editingTaskId === task.id}
        selected={selectedTaskId === task.id}
        checked={selectedTaskIds.has(task.id)}
        activeActorSeatIds={activeActorSeatIds}
        ownerLabel={ownerFor(task)}
        onSelect={onSelect}
        onToggleSelect={onToggleSelect}
        onMove={onMove}
        onApprove={onApprove}
        onEdit={onEdit}
        onCancelEdit={onCancelEdit}
        onSaveEdit={onSaveEdit}
      />
    );
  };

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
          {tasks.length > 0 ? (
            <label
              className="task-board-lane__select-all"
              title={selectAllLabel}
              onClick={(event) => event.stopPropagation()}
            >
              <input
                type="checkbox"
                className="task-board-select"
                data-testid={`task-lane-select-all-${lane.id}`}
                checked={selectState === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = selectState === "partial";
                }}
                aria-label={selectAllLabel}
                onChange={onSelectAllInLane}
              />
            </label>
          ) : null}
          <Icon size={13} aria-hidden />
          <h2 id={`task-lane-${lane.id}`} className="task-board-lane__title">
            {lane.label}
          </h2>
          <span className="task-board-lane__count" aria-label={`${tasks.length} tasks`}>
            {tasks.length}
          </span>
        </div>
        <div className="task-board-lane__header-actions">
          {headerAction}
          {createsTasks ? (
            <IconButton
              size="sm"
              tone="accent"
              aria-label={`Create task in ${lane.label}`}
              title="Create task"
              onClick={onCreate}
            >
              <Plus size={13} />
            </IconButton>
          ) : null}
        </div>
      </header>
      {headerDetail ? (
        <div className="task-board-lane__contract-glance">{headerDetail}</div>
      ) : null}
      {lane.hint ? <p className="task-board-lane__hint">{lane.hint}</p> : null}

      <div className="task-board-lane__list" role="list">
        {groups
          ? groups.map((group) => (
              <section key={group.key} className="task-path-group">
                <OutgoingGroupHeader
                  kind={group.kind}
                  board={group.board}
                  count={group.tasks.length}
                />
                {group.tasks.map((task) => renderCard(task))}
              </section>
            ))
          : tasks.map((task) => renderCard(task))}
        {tasks.length === 0 ? (
          <div className="task-board-lane__empty">
            <span>
              {searchActive
                ? "No matching tasks"
                : emptyText ?? `No ${lane.label.toLowerCase()}`}
            </span>
            {createsTasks && lane.id !== "incoming" && !searchActive ? (
              <button type="button" onClick={onCreate}>
                Create the first task
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskContractPanel({
  node,
  side,
  board,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly side: "incoming" | "outgoing";
  readonly board: string;
  readonly onClose: () => void;
}) {
  return (
    <aside
      className="task-board-contract-panel"
      role="complementary"
      aria-label={`${side === "incoming" ? "Incoming" : "Outgoing"} settings for ${board}`}
      data-testid={`task-board-contract-${side}`}
    >
      <OverlayHeader
        title="Board settings"
        status={
          side === "incoming"
            ? "How tasks enter this board and who can start them"
            : "What leaves this board with a task, and what runs before it goes."
        }
        actions={
          <IconButton
            aria-label={`Close ${side === "incoming" ? "incoming" : "outgoing"} settings`}
            title="Close contract"
            onClick={onClose}
          >
            <X size={14} />
          </IconButton>
        }
      />
      <div className="task-board-contract-panel__body">
        <BoardSettings node={node} focusSide={side} />
      </div>
    </aside>
  );
}

function TaskActionsMenu({
  task,
  lane,
  lanes,
  pending,
  needsApproval,
  onEdit,
  onMove,
  onApprove,
}: {
  readonly task: WorkTask;
  readonly lane: LaneDefinition;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly pending: boolean;
  readonly needsApproval: boolean;
  readonly onEdit: (task: WorkTask) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onApprove: (task: WorkTask) => void;
}) {
  const menuId = `task-actions-${useId().replaceAll(":", "")}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const brief = taskTitle(task);
  const availableMoves = lanes.filter(
    (target) =>
      target.state &&
      target.id !== lane.id &&
      !(task.state === "completed" && target.state === "submitted") &&
      canTransitionTaskState(task.state, target.state),
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
        {needsApproval ? (
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => commit(() => onApprove(task))}
          >
            Approve
          </button>
        ) : null}
        {!needsApproval ? (
          <button type="button" role="menuitem" onClick={() => commit(() => onEdit(task))}>
            Edit title
          </button>
        ) : null}
        {!needsApproval
          ? availableMoves.map((target) => (
              <button
                key={target.id}
                type="button"
                role="menuitem"
                disabled={pending}
                onClick={() =>
                  commit(() => {
                    if (target.state) onMove(task, target.state);
                  })
                }
              >
                {target.id === "queue" || target.id === "incoming"
                  ? `Return to ${target.label}`
                  : `Move to ${target.label}`}
              </button>
            ))
          : null}
        {!needsApproval && terminalActions.length > 0 ? (
          <div className="task-board-card__menu-separator" aria-hidden />
        ) : null}
        {!needsApproval
          ? terminalActions.map(([state, label]) => (
              <button
                key={state}
                type="button"
                role="menuitem"
                disabled={pending}
                data-terminal-action={state}
                data-testid={
                  state === "archived" ? "task-menu-delete-from-board" : undefined
                }
                onClick={() => commit(() => onMove(task, state))}
              >
                {label}
              </button>
            ))
          : null}
      </div>
    </>
  );
}

function TaskCard({
  task,
  allTasks,
  lane,
  lanes,
  index,
  mark,
  needsApproval,
  pending,
  editing,
  selected,
  checked,
  activeActorSeatIds,
  ownerLabel,
  onSelect,
  onToggleSelect,
  onMove,
  onApprove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly task: WorkTask;
  readonly allTasks: ReadonlyArray<WorkTask>;
  readonly lane: LaneDefinition;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly index: number;
  /** Queue and Incoming admission mark, rendered beside the state chip. */
  readonly mark?: ReactNode;
  readonly needsApproval: boolean;
  readonly pending: boolean;
  readonly editing: boolean;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly ownerLabel?: string;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleSelect: (taskId: string) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
  readonly onApprove: (task: WorkTask) => void;
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
    disabled: TERMINAL_STATES.has(task.state) || needsApproval || pending,
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
        TERMINAL_STATES.has(task.state) || needsApproval || pending
          ? "false"
          : "true"
      }
      data-testid="task-board-card"
      data-checked={checked ? "true" : "false"}
      role="listitem"
      tabIndex={0}
      aria-busy={pending}
      aria-selected={checked}
      aria-label={`Open details for ${brief}${
        mediaCount > 0 ? `, ${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}` : ""
      }${
        claimantRetired ? ", stalled because its claimed seat is retired" : ""
      }`}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        if (editing) return;
        // Meta/ctrl-click toggles multi-select without leaving the card focus path.
        if (event.metaKey || event.ctrlKey) {
          onToggleSelect(task.id);
          return;
        }
        onSelect(task.id);
      }}
      onKeyDown={(event) => {
        if (!editing && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) onToggleSelect(task.id);
          else onSelect(task.id);
        }
      }}
    >
      <div className="task-board-card__topline">
        <label
          className="task-board-card__check"
          title="Select for bulk actions"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            className="task-board-select"
            data-testid="task-board-card-check"
            checked={checked}
            aria-label={`Select ${brief}`}
            onChange={() => onToggleSelect(task.id)}
          />
        </label>
        <span
          ref={sortable.handleRef}
          className="task-board-card__handle"
          aria-label={`Drag ${brief}`}
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
                ref={claimFocusOnMount}
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
                {ownerLabel ? (
                  <span className="task-board-card__claimant" title={claim}>
                    <UserRound size={10} aria-hidden />
                    {ownerLabel}
                  </span>
                ) : null}
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
            lanes={lanes}
            pending={pending}
            needsApproval={needsApproval}
            onEdit={onEdit}
            onMove={onMove}
            onApprove={onApprove}
          />
        ) : null}
      </div>

      {!editing ? (
        <footer className="task-board-card__footer">
          <div className="task-board-card__status-chips">
            <Chip tone={chipToneForState(task.state)}>
              {stateLabel(task.state)}
            </Chip>
            {mark}
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
                title="Still claimed by an agent that is no longer on the canvas"
              >
                Stalled
              </Chip>
            ) : null}
          </div>
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

type CreateDialogMode = "task";

/** Focus portal (board) or inline workbench pane (pinnable enqueue). */
export type TaskCreateShell = "focus" | "inline";

export function TaskCreateDialog({
  mode,
  pending,
  artifactsNodeId,
  admissionFloor,
  onClose,
  onCreate,
  shell = "focus",
  stayOpen = false,
  resetToken = 0,
  headerActions,
  preamble,
}: {
  readonly mode: "task";
  readonly pending: boolean;
  /** Resolved from canvas; not operator-authored at create. */
  readonly artifactsNodeId: string | undefined;
  /** Minimum admission policy imposed by this board. */
  readonly admissionFloor: TaskAdmission;
  readonly onClose: () => void;
  readonly onCreate: (
    title: string,
    details: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string>,
    finishCriteria: import("@shared/work-model").FinishCriteria | undefined,
    options: TaskCreateOptions | undefined,
  ) => void;
  readonly shell?: TaskCreateShell;
  /**
   * When true, submit does not imply dismiss — caller keeps the surface open
   * and bumps `resetToken` after a successful create so fields clear for the next.
   */
  readonly stayOpen?: boolean;
  readonly resetToken?: number;
  /**
   * Workbench chrome (pin + close). When set, replaces the default header
   * close button so the shell does not double up identical dismiss controls.
   */
  readonly headerActions?: ReactNode;
  /** Compact, collapsed path context shown after the work description. */
  readonly preamble?: ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
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
  const [admission, setAdmission] = useState<TaskAdmission>(() =>
    defaultTaskAdmission(admissionFloor),
  );
  const [waitFor, setWaitFor] = useState("");
  const [waitError, setWaitError] = useState("");
  const admissionChoices = taskAdmissionChoices(admissionFloor);

  useEffect(() => {
    if (resetToken === 0) return;
    setTitle("");
    setDetails("");
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
    setAdmission(defaultTaskAdmission(admissionFloor));
    setWaitFor("");
    setWaitError("");
  }, [admissionFloor, resetToken]);

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
    const image = await extractClipboardImage(data);
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
      const image = await fileToClipboardImage(file);
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
              setFormError("Add an Artifacts card to the canvas before requiring artifacts.");
              return;
            }
            const parsedWait = parseTaskWait(waitFor);
            if (!parsedWait.ok) {
              setWaitError(parsedWait.message);
              return;
            }
            setWaitError("");
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
              parts,
              dependsOn,
              finishCriteria,
              {
                admission,
                ...(parsedWait.ms !== undefined
                  ? { waitForMs: parsedWait.ms }
                  : {}),
              },
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
                  ref={claimFocusOnMount}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What needs doing?"
                  maxLength={180}
                />
              </label>
              <label className="task-create-dialog__description">
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
                  rows={7}
                  aria-invalid={formError === "Description is required."}
                />
              </label>

              {preamble ? (
                <details className="task-create-dialog__path">
                  <summary>
                    <span>
                      <strong>Path</strong>
                      <small>Boards this task can move to, and the rules in force there</small>
                    </span>
                    <span className="task-create-dialog__path-action">Show path</span>
                  </summary>
                  <div className="task-create-dialog__path-map">{preamble}</div>
                </details>
              ) : null}

              <label className="task-create-dialog__criteria">
                <FieldCaption
                  label="Finish criteria"
                  help="What finished looks like, in your words."
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
              <section className="task-create-dialog__admission" aria-labelledby="task-admission-label">
                  <div className="task-create-dialog__admission-heading">
                    <div>
                      <strong id="task-admission-label">Who starts it</strong>
                      <span>{`This board's default: ${admissionLabel(admissionFloor)}`}</span>
                    </div>
                  </div>
                  <div className="task-create-dialog__admission-options" role="group" aria-label="Task admission">
                    {admissionChoices.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className="task-create-dialog__admission-option"
                        data-selected={String(admission === choice.value)}
                        aria-pressed={admission === choice.value}
                        disabled={choice.disabled || pending}
                        title={choice.reason}
                        onClick={() => setAdmission(choice.value)}
                      >
                        <strong>{choice.label}</strong>
                        <span>{choice.outcome}</span>
                        {choice.reason ? <small>{choice.reason}</small> : null}
                      </button>
                    ))}
                  </div>
                  <label className="task-create-dialog__wait">
                    <FieldCaption
                      label="Wait before starting"
                      help="Delay claimability from creation. The board's Wait before starting still applies when this is blank."
                    />
                    <Input
                      aria-label="Wait before starting duration"
                      value={waitFor}
                      onChange={(event) => {
                        setWaitFor(event.target.value);
                        if (waitError) setWaitError("");
                      }}
                      placeholder="90m, 12h, 7d"
                      aria-invalid={waitError ? true : undefined}
                    />
                    {waitError ? <small className="task-create-dialog__wait-error" role="alert">{waitError}</small> : null}
                  </label>
                </section>

              <label>
                <FieldCaption
                  label="Depends on"
                  help="Tasks that must finish first. Empty means this can start right away."
                />
                <Input
                  aria-label="Depends on"
                  value={dependsOnText}
                  onChange={(event) => setDependsOnText(event.target.value)}
                  placeholder="task ids (same region)…"
                />
              </label>

              <div className="task-create-dialog__gates">
                <div className="task-create-dialog__gates-heading">
                  <FieldCaption
                    label="Hard finish gates"
                    help="What must exist before this task can complete."
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
                        : "No Artifacts card on this canvas"
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
                        help="What the agent should publish when the work is done."
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
                    help="Paste, drop, or attach images. They travel with the task."
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
            {stayOpen ? null : (
              <Button type="button" variant="subtle" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={pending || !title.trim()}>
              {pending
                ? "Creating…"
                : stayOpen
                  ? "Add task"
                  : "Create task"}
            </Button>
          </footer>
        </form>
  );

  const header = (
    <OverlayHeader
      eyebrow={stayOpen ? "quick enqueue" : undefined}
      title={stayOpen ? "Add to the queue" : "New task"}
      actions={
        headerActions !== undefined ? (
          headerActions
        ) : (
          <IconButton
            aria-label="Close task creator"
            title="Close"
            onClick={onClose}
            disabled={pending}
            data-testid="task-create-close"
          >
            <X size={14} />
          </IconButton>
        )
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
                ref={claimFocusOnMount}
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
        label="Create task"
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
              ref={claimFocusOnMount}
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
  nodeId,
  lanes,
  pending,
  claimantRetired,
  needsApproval,
  ownerLabel,
  seatName,
  nodeName,
  contract,
  actorRefs,
  doc,
  operatorPanel,
  onClose,
  onSaveTitle,
  onRespond,
  onReject,
  onMove,
  onApprove,
  onComment,
}: {
  readonly task: WorkTask;
  /** Tasks node the open row lives at — visits read their interiors from here. */
  readonly nodeId: string;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly pending: boolean;
  readonly claimantRetired: boolean;
  readonly needsApproval: boolean;
  readonly ownerLabel?: string;
  readonly seatName: (seatId: string) => string | undefined;
  readonly nodeName: (nodeId: string) => string | undefined;
  readonly contract: TasksContract | undefined;
  readonly actorRefs: ReadonlyArray<{ readonly seatId: string; readonly nodeId: string }>;
  readonly doc: CanvasDoc;
  /** Operator panel for an operator-admission board; absent elsewhere. */
  readonly operatorPanel?: ReactNode;
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
  readonly onComment: (task: WorkTask, text: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(() => taskTitle(task));
  const [response, setResponse] = useState("");
  const [rejectionComment, setRejectionComment] = useState("");
  const claim = claimedByOf(task);
  const details = taskDetails(task);
  const legacyMedia = taskMediaParts(task);
  const contentMedia = taskContentParts(task);
  const attentionRequired =
    task.state === "input-required" || task.state === "auth-required";
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
  const transitionOptions = needsApproval
    ? []
    : [
        ...lanes.flatMap((lane) =>
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
          !lanes.some((lane) => lane.state === state) &&
          !(state === "completed" && hardFinishGate)
            ? [{ value: state, label }]
            : [],
        ),
      ];
  const queueLaneLabel =
    lanes.find((lane) => lane.state === "submitted")?.label ?? "Queue";
  const authorSeatId = claimedByOf(task);
  const authorNodeId = actorRefs.find((actor) => actor.seatId === authorSeatId)?.nodeId;
  const reviewGate = reviewGateOf(task, contract, authorSeatId, {
    reviewerHasCurrentEdge: (reviewerSeatId) => {
      if (authorNodeId === undefined) return false;
      const reviewerNodeId = actorRefs.find((actor) => actor.seatId === reviewerSeatId)?.nodeId;
      if (reviewerNodeId === undefined) return false;
      return doc.edges.some(
        (edge) =>
          reviewsEdgeHoldsVerdictPost(edge) &&
          edge.fromNode === reviewerNodeId &&
          edge.toNode === authorNodeId,
      );
    },
  });
  const reviewVerdicts = verdictsOnTask(task);

  return (
    <aside
      className="task-detail-panel"
      data-testid="task-detail"
      aria-label={`Details for ${taskTitle(task)}`}
    >
      <header className="task-detail-panel__header">
        <div>
          <div className="task-detail-panel__chips">
            <Chip tone={chipToneForState(task.state)}>
              {stateLabel(task.state)}
            </Chip>
            {claimantRetired ? (
              <Chip
                tone="crimson"
                title="Still claimed by an agent that is no longer on the canvas"
              >
                Stalled
              </Chip>
            ) : null}
            {needsApproval && onApprove ? (
              <Button
                size="xs"
                variant="primary"
                disabled={pending}
                title="Approve this task so agents can claim it"
                data-testid="task-detail-approve"
                onClick={() => onApprove(task)}
              >
                <CheckCircle2 size={12} />
                Approve
              </Button>
            ) : null}
            {!needsApproval && canTransitionTaskState(task.state, "archived") ? (
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
            {!needsApproval &&
            task.state !== "completed" &&
            claim &&
            canTransitionTaskState(task.state, "submitted") ? (
              <Button
                size="xs"
                variant="subtle"
                disabled={pending}
                title={`Clear this claim and return the task to ${queueLaneLabel}`}
                onClick={() => onMove(task, "submitted")}
              >
                <RotateCcw size={12} />
                Return to {queueLaneLabel}
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
        <span title="Task ID">#{task.id}</span>
        {ownerLabel ? (
          <span className="task-detail-panel__claim" title={claim}>
            <UserRound size={12} aria-hidden />
            {ownerLabel}
          </span>
        ) : null}
        {rejectedTimes !== undefined ? (
          <span title="Times returned to Queue after QA rejection">
            QA rejects: {rejectedTimes}
          </span>
        ) : null}
      </div>

      <div className="task-detail-panel__scroll">
        {operatorPanel}
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
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  if (!(event.metaKey || event.ctrlKey)) return;
                  event.preventDefault();
                  if (pending || !response.trim()) return;
                  void onRespond(task, response.trim(), "working").then((ok) => {
                    if (ok) setResponse("");
                  });
                }}
                placeholder="Give the worker the context, decision, or answer needed to continue…"
                rows={5}
                aria-keyshortcuts="Meta+Enter Control+Enter"
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
                title="⌘↵ / Ctrl+Enter"
              >
                <Reply size={13} />
                Send input &amp; resume
              </Button>
            </div>

            {/* Pin before sending: the answer resumes the task, and with it
                this whole section goes away. */}
            <PinRulingControl nodeId={nodeId} text={response} sourceRequestId={task.id} />
          </section>
        ) : null}

        <TaskThread
          task={task}
          pending={pending}
          seatName={seatName}
          nodeName={nodeName}
          onComment={(text) => onComment(task, text)}
        />

        {reviewGate.required || reviewVerdicts.length > 0 ? (
          <>
            <RequiresReviewControl gate={reviewGate} />
            <VerdictChain verdicts={reviewVerdicts} gate={reviewGate} />
          </>
        ) : null}

        <section className="task-detail-panel__section">
          <h3>Title</h3>
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

        <TaskVisits task={task} nodeId={nodeId} />

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
                  ? ` - names: ${task.finishCriteria.artifacts.names.join(", ")}`
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

        {task.state === "completed" ? (
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
              Thread for the next worker.
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

        <section className="task-detail-panel__section task-detail-panel__status">
          <div>
            <h3>{attentionRequired ? "Other status changes" : "Status"}</h3>
            <p>
              {task.state === "completed"
                ? "Completed work can go back to the queue through review, or be deleted."
                : attentionRequired
                ? "Use this only when the task should leave the response workflow without resuming."
                : "Move this task to another status, or delete it."}
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
  const boardSettings = node.ether?.tasks?.contract;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const glance = sinkGlance(items, boardSettings, nowMs);
  // "Open" = unfinished work the fleet can act on: claimable/submitted +
  // working. Input-required and residual auth-required are attention waits,
  // not flight — they render as their own counter, disjoint from open.
  const openCount = useMemo(
    () => items.filter((task) => task.state === "submitted" || task.state === "working").length,
    [items],
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hideClosed, setHideClosed] = useState(false);
  const [contractSide, setContractSide] = useState<"incoming" | "outgoing" | null>(null);
  const [creating, setCreating] = useState<CreateDialogMode | null>(null);
  const [creatingPending, setCreatingPending] = useState(false);
  // Task rules from the creation path, cleared each time the composer opens
  // or closes so a stale rule never survives across creation sessions.
  const [creationRules, setCreationRules] = useState<ReadonlyArray<TaskRule>>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeLane, setActiveLane] = useState<LaneId | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    if (
      initialItemId &&
      items.some((task) => task.id === initialItemId)
    ) {
      return initialItemId;
    }
    return null;
  });
  /** Multi-select for column bulk actions (independent of detail focus). */
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
    () => (initialItemId ? new Set([initialItemId]) : new Set()),
  );
  const [bulkPending, setBulkPending] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const api = getJuntoApi();
  const name = canvasName();
  const actorRefs = use$(state$.actorRefs);
  const activeActorSeatIds = useMemo(
    () => new Set<string>(actorRefs.map((actor) => actor.seatId)),
    [actorRefs],
  );
  const doc = use$(state$.doc);
  // Columns follow the flow edges: incoming flow turns Queue into Incoming,
  // outgoing flow turns Closed into Sent on.
  const shape = useMemo(() => taskPathShape(doc, node.id), [doc, node.id]);
  // An operator-admission board never hands work to a seat: the operator
  // answers the rules and completes or sends on from the detail panel.
  const operatorOwned = resolveTaskAdmission(boardSettings) === "operator";
  const boardName = useMemo(() => {
    const names = new Map(
      doc.nodes.map((entry) => [
        entry.id,
        tasksNodeName(entry),
      ]),
    );
    return (nodeId: string): string =>
      names.get(nodeId) ?? tasksNodeName(undefined, nodeId);
  }, [doc]);
  const currentBoard = useMemo(
    () => tasksNodeIdentity(doc.nodes.find((entry) => entry.id === node.id), node.id),
    [doc, node.id],
  );
  // Kind-aware display names for ACTORS (agent seats) and generic nodes.
  // tasksNodeName is the Tasks-board identity helper — applying it to agent
  // nodes mangled owner chips into "Tasks <id-fragment>"; agents read their
  // node title instead. Missing nodes fall back to the caller's raw id.
  const nodeName = useMemo(() => {
    const names = new Map(
      doc.nodes.flatMap((entry) => {
        const name =
          entry.ether?.entity?.kind === "task"
            ? tasksNodeName(entry)
            : nodeTitle(entry);
        // "untitled" is nodeTitle's empty-text placeholder; the caller's raw
        // id fallback reads better than a placeholder for an anonymous node.
        return name && name !== "untitled" ? [[entry.id, name] as const] : [];
      }),
    );
    return (nodeId: string): string | undefined => names.get(nodeId);
  }, [doc]);
  const seatName = useMemo(() => {
    const names = new Map<string, string>(
      actorRefs.map((actor) => [actor.seatId, nodeName(actor.nodeId) ?? actor.nodeId]),
    );
    return (seatId: string): string | undefined => names.get(seatId);
  }, [actorRefs, nodeName]);
  const ownerFor = (task: WorkTask): string | undefined => {
    const owner = currentTaskOwner(task, boardSettings);
    if (owner.kind === "operator") return "Operator";
    if (owner.kind === "seat") return seatName(owner.seatId) ?? owner.seatId;
    return undefined;
  };
  const laneCopy = useMemo(
    () => taskPathLaneCopy(shape, boardName),
    [shape, boardName],
  );
  const incomingContractGlance = useMemo(() => {
    const admission = resolveTaskAdmission(boardSettings);
    const wait = formatWait(boardSettings?.incoming?.waitMs);
    return {
      admission: `Starts: ${admissionLabel(admission)}`,
      wait: `Wait: ${wait || "none"}`,
    };
  }, [boardSettings]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((task) => {
      const claim = claimedByOf(task)?.toLowerCase() ?? "";
      return (
        taskTitle(task).toLowerCase().includes(normalized) ||
        Boolean(taskDetails(task)?.toLowerCase().includes(normalized)) ||
        claim.includes(normalized)
      );
    });
  }, [items, query]);

  const tasksByLane = useMemo(() => {
    const grouped: Record<LaneId, WorkTask[]> = {
      queue: [],
      incoming: [],
      working: [],
      input: [],
      outgoing: [],
      closed: [],
    };
    for (const task of visibleItems) {
      grouped[laneForTask(task, shape, boardSettings, nowMs)].push(task);
    }
    // Latest activity first in every lane (Closed especially: complete by latest).
    for (const laneId of Object.keys(grouped) as LaneId[]) {
      grouped[laneId].sort(compareTasksByLatestActivityDesc);
    }
    return grouped;
  }, [nowMs, query, shape, boardSettings, visibleItems]);

  const outgoingGroups = useMemo((): ReadonlyArray<TaskLaneGroup> | undefined => {
    if (!shape.hasOutgoing) return undefined;
    return groupOutgoingVisits(
      tasksByLane.outgoing,
      node.id,
      shape.destinations,
    ).map((group) => ({
      key: group.key,
      kind: group.kind,
      ...(group.boardId !== undefined
        ? { board: boardName(group.boardId) }
        : {}),
      tasks: group.tasks,
    }));
  }, [node.id, shape, boardName, tasksByLane]);

  const activeTask = activeTaskId ? items.find((task) => task.id === activeTaskId) : undefined;
  const selectedTask = selectedTaskId
    ? items.find((task) => task.id === selectedTaskId)
    : undefined;
  const selectedBulkItems = useMemo(() => {
    if (selectedTaskIds.size === 0) return [];
    const out: WorkTask[] = [];
    for (const id of selectedTaskIds) {
      const task = items.find((entry) => entry.id === id);
      if (!task) continue;
      out.push(task);
    }
    return out;
  }, [items, selectedTaskIds]);
  const bulkActions = useMemo(
    () =>
      resolveTaskBoardBulkActions(
        selectedBulkItems.map((task) => ({
          id: task.id,
          state: task.state,
          hardFinishGate:
            task.finishCriteria?.artifacts !== undefined ||
            task.finishCriteria?.git !== undefined,
        })),
      ),
    [selectedBulkItems],
  );
  /** Region-scoped tasks for dep glance (cross-sink prereqs in the same region). */
  const scopeTasks = useMemo(
    () => dependencyScopeTasks(doc, node.id),
    [doc, node.id],
  );

  // Wait countdowns tick only while some Queue or Incoming task is still waiting.
  const holdLaneTasks = shape.hasIncoming ? tasksByLane.incoming : tasksByLane.queue;
  useEffect(() => {
    if (!hasPendingWait(holdLaneTasks, Date.now())) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (!hasPendingWait(holdLaneTasks, next)) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [holdLaneTasks]);

  const createTask = async (
    title: string,
    details: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string> = [],
    finishCriteria?: import("@shared/work-model").FinishCriteria,
    rules: ReadonlyArray<TaskRule> = [],
    options?: TaskCreateOptions,
  ) => {
    if (!api || !title.trim() || !details.trim()) return;
    setError("");
    setCreatingPending(true);
    try {
      const metadata: WorkMetadata = {
        title: title.trim(),
        details: details.trim(),
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
          rules.length > 0 ? rules : undefined,
          options,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(
        `Created ${title.trim()} in ${laneById(laneForTask(result.data, shape, boardSettings, Date.now())).label}.`,
      );
      setCreating(null);
      setCreationRules([]);
      setSelectedTaskId(result.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingPending(false);
    }
  };

  const focusTask = (taskId: string, mode: TaskBoardSelectMode = "replace") => {
    setSelectedTaskId(taskId);
    setSelectedTaskIds((current) => applyTaskBoardSelection(current, taskId, mode));
  };

  const toggleTaskChecked = (taskId: string) => {
    setSelectedTaskIds((current) => applyTaskBoardSelection(current, taskId, "toggle"));
  };

  const clearTaskSelection = () => {
    setSelectedTaskIds(new Set());
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
        setAnnouncement(
          `Rejected ${taskTitle(task)} and returned it to ${
            shape.hasIncoming ? INCOMING_LANE.label : laneById("queue").label
          }.`,
        );
      } else if (state === "archived") {
        setSelectedTaskId((current) => (current === task.id ? null : current));
        setSelectedTaskIds((current) => {
          if (!current.has(task.id)) return current;
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
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

  const runBulkAction = async (action: TaskBoardBulkAction) => {
    if (selectedBulkItems.length === 0 || bulkPending) return;
    setBulkPending(true);
    setError("");
    let okCount = 0;
    let failCount = 0;
    let lastError = "";
    try {
      for (const task of selectedBulkItems) {
        const ok = await transitionTask(task, action.state);
        if (ok) okCount += 1;
        else failCount += 1;
      }
      if (okCount > 0 && failCount === 0) {
        setAnnouncement(`${action.label} — ${okCount} done.`);
        clearTaskSelection();
        if (action.kind === "transition" && action.state === "archived") {
          setSelectedTaskId(null);
        }
      } else if (okCount > 0) {
        setAnnouncement(
          `${action.label}: ${okCount} ok, ${failCount} failed${
            lastError ? ` — ${lastError}` : ""
          }.`,
        );
        if (lastError) setError(lastError);
      } else {
        setAnnouncement(
          `Could not run bulk action${lastError ? `: ${lastError}` : "."}`,
        );
        if (lastError) setError(lastError);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Bulk action failed. ${message}`);
    } finally {
      setBulkPending(false);
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

  const promoteTask = async (task: WorkTask, note?: string) => {
    if (!api) {
      setError("Approval is not available until the current work service is ready.");
      return;
    }
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskPromote(name, node.id, task.id, note?.trim() || undefined),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not approve ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setAnnouncement(`Approved ${taskTitle(task)} so agents can claim it.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not approve ${taskTitle(task)}. ${message}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  const approvalMarkFor = (task: WorkTask): ReactNode => {
    if (task.state !== "submitted") return null;
    const glance = incomingGlance(task, boardSettings, nowMs);
    return (
      <ApprovalMark
        glance={glance}
        gatedBoard={resolveTaskAdmission(boardSettings) === "approval"}
        pending={pendingTaskId === task.id}
        onPromote={
          glance.promotable ? (note) => void promoteTask(task, note) : undefined
        }
      />
    );
  };
  const needsApprovalFor = (task: WorkTask): boolean =>
    taskNeedsApproval(task, boardSettings, nowMs);

  /**
   * Operator completion at a board: the rule answers ride in the completion
   * evidence; `next` names the Next board (absent = completion here). The
   * work service checks the shape of the submission and re-homes the row.
   */
  const completeAtBoard = async (
    task: WorkTask,
    submission: RuleSubmission,
    next: string | undefined,
  ): Promise<boolean> => {
    if (!api) return false;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskTransition(
          name,
          node.id,
          task.id,
          "completed",
          submission.note,
          {
            artifacts: [],
            ...(submission.claims.length > 0
              ? { claims: submission.claims }
              : {}),
            ...(submission.waivers.length > 0
              ? { waivers: submission.waivers }
              : {}),
          },
          next !== undefined
            ? {
                next,
                ...(submission.note !== undefined
                  ? { handoffNote: submission.note }
                  : {}),
              }
            : undefined,
        ),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not complete ${taskTitle(task)}. ${result.message}`);
        return false;
      }
      setAnnouncement(
        next === undefined
          ? `Completed ${taskTitle(task)}.`
          : `Sent ${taskTitle(task)} on to ${boardName(next)}.`,
      );
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not complete ${taskTitle(task)}. ${message}`);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  /** Send back: the row returns to an earlier board, one epoch later. */
  const sendBackDefect = async (
    task: WorkTask,
    summary: string,
    refs: ReadonlyArray<string>,
    defectNote: string,
    target: string | undefined,
  ): Promise<boolean> => {
    if (!api || !summary.trim()) return false;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskTransition(
          name,
          node.id,
          task.id,
          "rejected",
          defectNote.trim() ? defectNote.trim() : undefined,
          undefined,
          {
            defect: {
              summary: summary.trim(),
              ...(refs.length > 0 ? { refs } : {}),
              ...(target !== undefined ? { target } : {}),
            },
          },
        ),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not send ${taskTitle(task)} back. ${result.message}`);
        return false;
      }
      setAnnouncement(
        target === undefined
          ? `Sent ${taskTitle(task)} back as a defect.`
          : `Sent ${taskTitle(task)} back to ${boardName(target)} as a defect.`,
      );
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not send ${taskTitle(task)} back. ${message}`);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  const approveTask = async (task: WorkTask) => {
    if (!api) return;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskPromote(name, node.id, task.id, undefined),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not approve ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setAnnouncement(`Approved ${taskTitle(task)} so agents can claim it.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not approve ${taskTitle(task)}. ${message}`);
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

  const commentOnTask = async (
    task: WorkTask,
    text: string,
  ): Promise<boolean> => {
    if (!api || !text.trim()) return false;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskComment(name, node.id, task.id, text.trim()),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not comment on ${taskTitle(task)}. ${result.message}`);
        return false;
      }
      setAnnouncement(`Comment added to ${taskTitle(task)}.`);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not comment on ${taskTitle(task)}. ${message}`);
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
        `Picked up ${taskTitle(task)} from ${ALL_LANES.find((lane) => lane.id === data.laneId)?.label}.`,
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
    const state = targetState(targetLane);
    if (!state) {
      setAnnouncement("Choose how this task should close.");
      return;
    }
    void transitionTask(task, state);
  };

  const boardLanes = visibleLanes(shape);
  // The final column is Closed on a plain board, Sent on on a path board.
  const closingLaneLabel = (
    shape.hasOutgoing ? OUTGOING_LANE.label : laneById("closed").label
  ).toLowerCase();
  const shownLanes = hideClosed
    ? boardLanes.filter((lane) => lane.id !== "closed" && lane.id !== "outgoing")
    : boardLanes;

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Task board"
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
          eyebrow="Tasks"
          title={currentBoard.name}
          status={
            <>
              <span>
                {`${openCount} open${glance.needsInput > 0 ? ` - ${glance.needsInput} need input` : ""}`}
              </span>
              {boardSettings?.instructions ? (
                <>
                  {" — "}
                  <span>{boardSettings.instructions}</span>
                </>
              ) : null}
            </>
          }
          actions={
            <>
              <IconButton
                tone={contractSide ? "accent" : "default"}
                aria-label="Edit board settings"
                title="Edit board settings"
                onClick={() => {
                  setSelectedTaskId(null);
                  setContractSide((current) => (current ? null : "incoming"));
                }}
              >
                <Settings2 size={14} />
              </IconButton>
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
                aria-label={`${hideClosed ? "Show" : "Hide"} the ${closingLaneLabel} column`}
                title={`${hideClosed ? "Show" : "Hide"} the ${closingLaneLabel} column`}
                onClick={() => setHideClosed((hidden) => !hidden)}
              >
                <Filter size={14} />
              </IconButton>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreating("task")}
                data-testid="task-board-enqueue"
              >
                <Plus size={12} />
                Add task
              </Button>
              <IconButton aria-label="Close task board" title="Close" onClick={onClose}>
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
              ref={claimFocusOnMount}
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

        {/*
          The creation path rides above the form: on a board with outgoing flow
          it shows where the work can go and the rules in force along each path.
          It returns null for a board without outgoing flow, so Add Task there
          stays the plain quick-create path.
        */}
        {creating ? (
          <TaskCreateDialog
            mode="task"
            pending={creatingPending}
            artifactsNodeId={resolveArtifactsNodeId(node.id, doc)}
            admissionFloor={resolveTaskAdmission(boardSettings)}
            preamble={
              <TaskCreationPath
                nodeId={node.id}
                rules={creationRules}
                onRulesChange={setCreationRules}
              />
            }
            onClose={() => {
              if (!creatingPending) {
                setCreating(null);
                setCreationRules([]);
              }
            }}
            onCreate={(title, details, media, dependsOn, finishCriteria, options) =>
              void createTask(
                title,
                details,
                media,
                dependsOn,
                finishCriteria,
                creationRules,
                options,
              )
            }
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

        {selectedTaskIds.size > 0 ? (
          <div
            className="task-board-bulk-bar"
            data-testid="task-board-bulk-bar"
            role="toolbar"
            aria-label="Bulk task actions"
          >
            <span className="task-board-bulk-bar__count">
              {selectedTaskIds.size} selected
            </span>
            <div className="task-board-bulk-bar__actions">
              {bulkActions.map((action) => {
                const key =
                  action.kind === "transition"
                    ? `transition:${action.state}`
                    : action.kind;
                return (
                  <Button
                    key={key}
                    size="xs"
                    variant={
                      action.kind === "transition" &&
                      (action.state === "archived" ||
                        action.state === "canceled" ||
                        action.state === "failed" ||
                        action.state === "rejected")
                        ? "danger"
                        : "subtle"
                    }
                    disabled={bulkPending}
                    data-testid={`task-board-bulk-${key}`}
                    onClick={() => void runBulkAction(action)}
                  >
                    {action.label}
                  </Button>
                );
              })}
            </div>
            <button
              type="button"
              className="task-board-bulk-bar__clear"
              disabled={bulkPending}
              onClick={clearTaskSelection}
            >
              Clear selection
            </button>
          </div>
        ) : null}

        <div
          className="task-board-workspace"
          data-detail-open={selectedTask || contractSide ? "true" : "false"}
        >
          <div
            className="task-board-grid"
            style={{ ["--task-board-lanes" as string]: shownLanes.length }}
            data-lane-count={shownLanes.length}
            data-testid="task-board"
          >
            {shownLanes.map((lane) => (
              <TaskLane
                key={lane.id}
                lane={
                  lane.id === "queue" || lane.id === "incoming"
                    ? {
                        ...lane,
                        hint: admissionLaneHint(
                          tasksByLane[lane.id],
                          boardSettings,
                          nowMs,
                          lane.hint,
                        ),
                      }
                    : lane
                }
                lanes={boardLanes}
                tasks={tasksByLane[lane.id]}
                groups={lane.id === "outgoing" ? outgoingGroups : undefined}
                headerDetail={
                  lane.id === "incoming" ? (
                    <>
                      <span>{incomingContractGlance.admission}</span>
                      <span>{incomingContractGlance.wait}</span>
                    </>
                  ) : lane.id === "outgoing" ? (
                    <span>{laneCopy.outgoingHint}</span>
                  ) : undefined
                }
                headerAction={
                  lane.id === "incoming" || lane.id === "outgoing" ? (
                    <IconButton
                      size="sm"
                      aria-label={`Edit ${lane.id === "incoming" ? "incoming" : "outgoing"} settings`}
                      title={`Edit ${lane.id === "incoming" ? "incoming" : "outgoing"} settings`}
                      onClick={() => {
                        setSelectedTaskId(null);
                        setContractSide(lane.id === "incoming" ? "incoming" : "outgoing");
                      }}
                    >
                      <Settings2 size={13} />
                    </IconButton>
                  ) : undefined
                }
                emptyText={
                  lane.id === "incoming"
                    ? laneCopy.incomingEmpty
                    : lane.id === "outgoing"
                      ? laneCopy.outgoingEmpty
                      : undefined
                }
                markFor={
                  lane.id === "queue" || lane.id === "incoming"
                    ? approvalMarkFor
                    : undefined
                }
                needsApprovalFor={needsApprovalFor}
                allTasks={scopeTasks}
                searchActive={Boolean(query.trim())}
                activeLane={activeLane}
                pendingTaskId={pendingTaskId}
                editingTaskId={editingTaskId}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={selectedTaskIds}
                activeActorSeatIds={activeActorSeatIds}
                ownerFor={ownerFor}
                onCreate={() => setCreating("task")}
                onSelect={(taskId) => {
                  setContractSide(null);
                  focusTask(taskId, "replace");
                }}
                onToggleSelect={toggleTaskChecked}
                onSelectAllInLane={() => {
                  const columnIds = tasksByLane[lane.id].map((task) => task.id);
                  setSelectedTaskIds((current) =>
                    toggleSelectAllInColumn(current, columnIds),
                  );
                }}
                onMove={(task, state) => void transitionTask(task, state)}
                onApprove={(task) => void approveTask(task)}
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
              nodeId={node.id}
              lanes={boardLanes}
              pending={pendingTaskId === selectedTask.id}
              needsApproval={needsApprovalFor(selectedTask)}
              claimantRetired={isTaskClaimantRetired(
                selectedTask.state,
                claimedByOf(selectedTask),
                activeActorSeatIds,
              )}
              ownerLabel={ownerFor(selectedTask)}
              seatName={seatName}
              nodeName={nodeName}
              contract={node.ether?.tasks?.contract}
              actorRefs={actorRefs}
              doc={doc}
              operatorPanel={
                operatorOwned &&
                !TERMINAL_STATES.has(selectedTask.state) ? (
                  <TaskOperatorPanel
                    rules={rulesInForce(doc, node.id, selectedTask)}
                    nextBoards={shape.destinations.map((board) => ({
                      id: board,
                      label: boardName(board),
                    }))}
                    defectTargets={defectTargetOptions(
                      doc,
                      selectedTask,
                      node.id,
                    ).map((target) => ({
                      id: target.board,
                      label: boardName(target.board),
                      present: target.present,
                    }))}
                    previousBoard={selectedTask.visits?.at(-2)?.board}
                    canSendBack={(selectedTask.visits?.length ?? 0) > 1}
                    pending={pendingTaskId === selectedTask.id}
                    waivable={(ruleId, next) => {
                      if (next === undefined) return false;
                      const reachable = reachableBoards(doc, next);
                      return rulesInForce(doc, node.id, selectedTask).some(
                        (entry) =>
                          entry.rule.id === ruleId &&
                          entry.provenance.kind === "task" &&
                          entry.provenance.board !== node.id &&
                          !reachable.has(entry.provenance.board),
                      );
                    }}
                    onComplete={(submission, next) =>
                      completeAtBoard(selectedTask, submission, next)
                    }
                    onSendBack={(summary, refs, handoffNote, target) =>
                      sendBackDefect(
                        selectedTask,
                        summary,
                        refs,
                        handoffNote,
                        target,
                      )
                    }
                  />
                ) : undefined
              }
              onClose={() => setSelectedTaskId(null)}
              onSaveTitle={(task, title) => void saveTaskTitle(task, title)}
              onRespond={respondToTask}
              onReject={rejectCompletedTask}
              onMove={(task, state) => void transitionTask(task, state)}
              onApprove={(task) => void approveTask(task)}
              onComment={commentOnTask}
            />
          ) : null}
          {contractSide ? (
            <TaskContractPanel
              node={node}
              side={contractSide}
              board={boardName(node.id)}
              onClose={() => setContractSide(null)}
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
