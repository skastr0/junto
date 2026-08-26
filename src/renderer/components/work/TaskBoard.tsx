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
import { TaskJourney } from "./TaskJourney";
import { TaskThread } from "./TaskThread";
import { ArrivalMark, OutboundGroupHeader } from "./TaskFlowMarks";
import { TaskCreationMetroMap } from "../claims/creation";
import { PinRulingControl, SinkContractEditor } from "../claims";
import { formatBakeTime } from "../claims/sink-contract";
import { admissionLabel } from "../../lib/admission-labels";
import {
  TaskStationConsole,
  type StationSubmission,
} from "./TaskStationConsole";
import { effectiveClaimsStack, taskAdmissionState } from "@shared/claims";
import { defectTargetOptions } from "@shared/journey-integrity";
import {
  resolveSinkAdmission,
  type SinkAdmission,
  type TaskClaim,
} from "@shared/work-model";
import { currentTaskOwner } from "@shared/task-owner";
import {
  arrivalGlance,
  groupOutboundPassages,
  hasPendingHold,
  pipelineLaneCopy,
  pipelineShape,
  type OutboundGroupKind,
  type PipelineShape,
} from "./task-flow-columns";
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
import { applyWorkCanvasWrite } from "../../lib/mutations";
import {
  stationIdentity,
  stationName as displayStationName,
} from "@shared/station-identity";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import {
  extractClipboardImage,
  fileToClipboardImage,
  type ClipboardImage,
} from "../../lib/clipboard-image";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import {
  admissionFloorOutcome,
  defaultTaskAdmission,
  parseTaskHold,
  taskAdmissionChoices,
} from "./task-create-admission";
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

type LaneId =
  | "proposal"
  | "queue"
  | "inbound"
  | "working"
  | "input"
  | "outbound"
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
    id: "proposal",
    label: "Awaiting approval",
    tone: "violet",
    chipTone: "violet",
    icon: UserRound,
    hint: "Work waiting for your approval before workers can be assigned it",
  },
  {
    id: "queue",
    label: "Queue",
    state: "submitted",
    tone: "amber",
    chipTone: "amber",
    icon: CircleDot,
    hint: "Ready to be assigned",
  },
  {
    id: "working",
    label: "Working",
    state: "working",
    tone: "cyan",
    chipTone: "cyan",
    icon: LoaderCircle,
    hint: "Assigned work in motion",
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
    hint: "Completed and stopped work",
  },
];

/**
 * Pipeline columns. They stand in for the plain lanes when the sink sits on
 * flow edges: Inbound replaces Awaiting approval + Queue on the arrival side, Outbound
 * replaces Closed on the departure side. A sink with no flow edges never sees
 * them and renders exactly as before.
 */
const INBOUND_LANE: LaneDefinition = {
  id: "inbound",
  label: "Inbound",
  state: "submitted",
  tone: "amber",
  chipTone: "amber",
  icon: ArrowDownToLine,
  hint: "Arrivals from upstream stations, waiting to be admitted",
};

const OUTBOUND_LANE: LaneDefinition = {
  id: "outbound",
  label: "Outbound",
  tone: "green",
  chipTone: "green",
  icon: ArrowUpRight,
  hint: "Passages grouped by where the work went next",
};

const ALL_LANES: ReadonlyArray<LaneDefinition> = [
  ...LANES,
  INBOUND_LANE,
  OUTBOUND_LANE,
];

const laneById = (id: LaneId): LaneDefinition =>
  ALL_LANES.find((lane) => lane.id === id)!;

/** The columns this sink shows, in board order. */
export const visibleLanes = (
  shape: PipelineShape,
): ReadonlyArray<LaneDefinition> => [
  ...(shape.hasInbound
    ? [INBOUND_LANE]
    : [laneById("proposal"), laneById("queue")]),
  laneById("working"),
  laneById("input"),
  shape.hasOutbound ? OUTBOUND_LANE : laneById("closed"),
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
  shape: PipelineShape,
  contract: import("@shared/work-model").TasksSinkContract | undefined,
  nowMs: number,
): LaneId => {
  if (TERMINAL_STATES.has(task.state)) return shape.hasOutbound ? "outbound" : "closed";
  if (task.state === "working") return "working";
  // input-required and residual durable auth-required share one attention lane
  if (task.state === "input-required" || task.state === "auth-required") return "input";
  if (task.state === "submitted") {
    const admission = taskAdmissionState(task, contract, nowMs);
    if (shape.hasInbound) return "inbound";
    if (admission === "operator-gated") {
      return "proposal";
    }
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

const destinationState = (laneId: LaneId): TaskState | undefined =>
  ALL_LANES.find((lane) => lane.id === laneId)?.state;

/** One destination bucket inside the Outbound column. */
type TaskLaneGroup = {
  readonly key: string;
  readonly kind: OutboundGroupKind;
  /** Station name for forwarded/returned buckets. */
  readonly station?: string;
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
  allTasks,
  searchActive,
  activeLane,
  pendingTaskId,
  editingTaskId,
  selectedTaskId,
  selectedTaskIds,
  activeActorSeatIds,
  proposalById,
  ownerFor,
  onCreate,
  onApprove,
  onRejectProposal,
  onSelect,
  onToggleSelect,
  onSelectAllInLane,
  onMove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly lane: LaneDefinition;
  /** The columns this sink shows — the move menu offers only these. */
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly tasks: ReadonlyArray<WorkTask>;
  /** Outbound only: the same tasks, bucketed by where each passage went. */
  readonly groups?: ReadonlyArray<TaskLaneGroup>;
  /** Read-only contract facts shown directly under the column title. */
  readonly headerDetail?: ReactNode;
  /** Side-specific contract entry point rendered in the column header. */
  readonly headerAction?: ReactNode;
  /** Teaching copy for an empty column. */
  readonly emptyText?: string;
  /** Inbound only: the admission mark for an arrival. */
  readonly markFor?: (task: WorkTask) => ReactNode;
  readonly allTasks: ReadonlyArray<WorkTask>;
  readonly searchActive: boolean;
  readonly activeLane: LaneId | null;
  readonly pendingTaskId: string | null;
  readonly editingTaskId: string | null;
  readonly selectedTaskId: string | null;
  readonly selectedTaskIds: ReadonlySet<string>;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly proposalById: ReadonlyMap<string, string>;
  readonly ownerFor: (task: WorkTask) => string | undefined;
  readonly onCreate: () => void;
  readonly onApprove: (task: WorkTask) => void;
  readonly onRejectProposal?: (task: WorkTask) => void;
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
  // Add Task keeps its column entry wherever arrivals land — Queue on a plain
  // sink, Inbound on a pipeline sink.
  const createsTasks =
    lane.id === "queue" || lane.id === "proposal" || lane.id === "inbound";
  // Cards carry a lane-wide sortable index; the Outbound groups render the
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
        pending={pendingTaskId === task.id}
        editing={editingTaskId === task.id}
        selected={selectedTaskId === task.id}
        checked={selectedTaskIds.has(task.id)}
        activeActorSeatIds={activeActorSeatIds}
        proposalBy={proposalById.get(task.id)}
        ownerLabel={ownerFor(task)}
        onSelect={onSelect}
        onToggleSelect={onToggleSelect}
        onMove={onMove}
        onApprove={onApprove}
        onRejectProposal={onRejectProposal}
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
              aria-label={
                lane.id === "proposal"
                  ? "Add work for approval"
                  : `Create task in ${lane.label}`
              }
              title={lane.id === "proposal" ? "Add work for approval" : "Create task"}
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
      <p className="task-board-lane__hint">{lane.hint}</p>

      <div className="task-board-lane__list" role="list">
        {groups
          ? groups.map((group) => (
              <section key={group.key} className="task-flow-group">
                <OutboundGroupHeader
                  kind={group.kind}
                  station={group.station}
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
                : lane.id === "proposal"
                  ? "Nothing awaiting approval"
                  : emptyText ?? `No ${lane.label.toLowerCase()}`}
            </span>
            {createsTasks && lane.id !== "inbound" && !searchActive ? (
              <button type="button" onClick={onCreate}>
                {lane.id === "proposal"
                  ? "Add work for approval"
                  : "Create the first task"}
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
  station,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly side: "inbound" | "outbound";
  readonly station: string;
  readonly onClose: () => void;
}) {
  const arrivals = side === "inbound";
  return (
    <aside
      className="task-board-contract-panel"
      role="complementary"
      aria-label={`${arrivals ? "Arrivals" : "Departures"} contract for ${station}`}
      data-testid={`task-board-contract-${side}`}
    >
      <OverlayHeader
        eyebrow="station contract"
        title={arrivals ? "Arrivals" : "Departures"}
        status={
          arrivals
            ? "How work enters this station and becomes claimable"
            : "What this station publishes before work moves on"
        }
        actions={
          <IconButton
            aria-label={`Close ${arrivals ? "arrivals" : "departures"} contract`}
            title="Close contract"
            onClick={onClose}
          >
            <X size={14} />
          </IconButton>
        }
      />
      <div className="task-board-contract-panel__body">
        <SinkContractEditor node={node} focusSide={side} />
      </div>
    </aside>
  );
}

function TaskActionsMenu({
  task,
  lane,
  lanes,
  pending,
  isProposal,
  onEdit,
  onMove,
  onApprove,
  onRejectProposal,
}: {
  readonly task: WorkTask;
  readonly lane: LaneDefinition;
  readonly lanes: ReadonlyArray<LaneDefinition>;
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
  const availableMoves = lanes.filter(
    (destination) =>
      destination.state &&
      destination.id !== lane.id &&
      !(task.state === "completed" && destination.state === "submitted") &&
      canTransitionTaskState(task.state, destination.state),
  );
  const hardFinishGate =
    task.finishCriteria?.artifacts !== undefined ||
    task.finishCriteria?.git !== undefined;
  // Approval candidates are display-mapped to submitted WorkTasks; they must not get
  // task transition actions (Delete/Complete/…) — that calls workTaskTransition
  // with a proposal id and yields "task … not found". Use the approval actions only.
  const terminalActions = isProposal
    ? ([] as ReadonlyArray<readonly [TaskState, string]>)
    : (
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
            Reject pending work
          </button>
        ) : null}
        {!isProposal ? (
          <button type="button" role="menuitem" onClick={() => commit(() => onEdit(task))}>
            Edit title
          </button>
        ) : null}
        {!isProposal
          ? availableMoves.map((destination) => (
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
                {destination.id === "queue" || destination.id === "inbound"
                  ? `Unassign to ${destination.label}`
                  : `Move to ${destination.label}`}
              </button>
            ))
          : null}
        {!isProposal && terminalActions.length > 0 ? (
          <div className="task-board-card__menu-separator" aria-hidden />
        ) : null}
        {!isProposal
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
  pending,
  editing,
  selected,
  checked,
  activeActorSeatIds,
  proposalBy,
  ownerLabel,
  onSelect,
  onToggleSelect,
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
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly index: number;
  /** Inbound admission mark, rendered beside the state chip. */
  readonly mark?: ReactNode;
  readonly pending: boolean;
  readonly editing: boolean;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly proposalBy?: string;
  readonly ownerLabel?: string;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleSelect: (taskId: string) => void;
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
      data-checked={checked ? "true" : "false"}
      role="listitem"
      tabIndex={0}
      aria-busy={pending}
      aria-selected={checked}
      aria-label={`Open details for ${brief}${
        mediaCount > 0 ? `, ${mediaCount} media attachment${mediaCount === 1 ? "" : "s"}` : ""
      }${
        claimantRetired ? ", stalled because its assigned seat is retired" : ""
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
                {proposalBy || ownerLabel ? (
                  <span className="task-board-card__claimant" title={claim}>
                    <UserRound size={10} aria-hidden />
                    {proposalBy
                      ? proposalBy === "operator"
                        ? "Raised by operator"
                        : `Raised by ${proposalBy}`
                      : ownerLabel}
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
              {proposalBy !== undefined ? "Awaiting approval" : stateLabel(task.state)}
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
                title="Still assigned to an agent that is no longer on the canvas"
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
              {claimedByOf(task) ?? "Unassigned"}
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
  readonly mode: CreateDialogMode;
  readonly pending: boolean;
  /** Resolved from canvas; not operator-authored at create. */
  readonly artifactsNodeId: string | undefined;
  /** Minimum admission policy imposed by the destination sink. */
  readonly admissionFloor: SinkAdmission;
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
  /** Compact, collapsed route context shown after the work description. */
  readonly preamble?: ReactNode;
}) {
  const isProposal = mode === "proposal";
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
  const [admission, setAdmission] = useState<SinkAdmission>(() =>
    defaultTaskAdmission(admissionFloor),
  );
  const [holdFor, setHoldFor] = useState("");
  const [holdError, setHoldError] = useState("");
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
    setHoldFor("");
    setHoldError("");
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
            const parsedHold = parseTaskHold(holdFor);
            if (!parsedHold.ok) {
              setHoldError(parsedHold.message);
              return;
            }
            setHoldError("");
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
              isProposal
                ? undefined
                : {
                    admission,
                    ...(parsedHold.ms !== undefined
                      ? { holdForMs: parsedHold.ms }
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
                  autoFocus
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
                <details className="task-create-dialog__line">
                  <summary>
                    <span>
                      <strong>The line</strong>
                      <small>Stations and standing claims this work can reach</small>
                    </span>
                    <span className="task-create-dialog__line-action">Show route</span>
                  </summary>
                  <div className="task-create-dialog__line-map">{preamble}</div>
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
              {!isProposal ? (
                <section className="task-create-dialog__admission" aria-labelledby="task-admission-label">
                  <div className="task-create-dialog__admission-heading">
                    <div>
                      <strong id="task-admission-label">Admission</strong>
                      <span>{`Sink floor: ${admissionFloorOutcome(admissionFloor)}`}</span>
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
                  <label className="task-create-dialog__hold">
                    <FieldCaption
                      label="Optional hold"
                      help="Delay claimability from creation. The station bake still applies when this is blank."
                    />
                    <Input
                      aria-label="Optional hold duration"
                      value={holdFor}
                      onChange={(event) => {
                        setHoldFor(event.target.value);
                        if (holdError) setHoldError("");
                      }}
                      placeholder="90m, 12h, 7d"
                      aria-invalid={holdError ? true : undefined}
                    />
                    {holdError ? <small className="task-create-dialog__hold-error" role="alert">{holdError}</small> : null}
                  </label>
                </section>
              ) : null}

              <label>
                <FieldCaption
                  label="Depends on"
                  help="Tasks that must finish first. Empty means this can start right away."
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
                ? isProposal
                  ? "Adding…"
                  : "Creating…"
                : isProposal
                  ? "Add for approval"
                  : stayOpen
                    ? "Add task"
                    : "Create task"}
            </Button>
          </footer>
        </form>
  );

  const header = (
    <OverlayHeader
      eyebrow={isProposal ? "approval queue" : stayOpen ? "quick enqueue" : "new task"}
      title={stayOpen ? "Add to the queue" : "Define the work"}
      actions={
        headerActions !== undefined ? (
          headerActions
        ) : (
          <IconButton
            aria-label={isProposal ? "Close approval form" : "Close task creator"}
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
        label={isProposal ? "Add work for approval" : "Create task"}
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
  nodeId,
  lanes,
  pending,
  claimantRetired,
  isProposal,
  proposedBy,
  ownerLabel,
  seatName,
  nodeName,
  station,
  onClose,
  onSaveTitle,
  onRespond,
  onReject,
  onMove,
  onApprove,
  onRejectProposal,
  onComment,
}: {
  readonly task: WorkTask;
  /** Sink node the open row lives at — the journey reads its interiors from here. */
  readonly nodeId: string;
  readonly lanes: ReadonlyArray<LaneDefinition>;
  readonly pending: boolean;
  readonly claimantRetired: boolean;
  readonly isProposal: boolean;
  readonly proposedBy?: string;
  readonly ownerLabel?: string;
  readonly seatName: (seatId: string) => string | undefined;
  readonly nodeName: (nodeId: string) => string | undefined;
  /** Operator station console for an operator-owned sink; absent elsewhere. */
  readonly station?: ReactNode;
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
  const arrivalLaneLabel =
    lanes.find((lane) => lane.state === "submitted")?.label ?? "Queue";
  const proposedByLabel =
    proposedBy === undefined
      ? undefined
      : proposedBy === "operator"
        ? "Raised by operator"
        : `Raised by ${proposedBy}`;

  return (
    <aside className="task-detail-panel" aria-label={`Details for ${taskTitle(task)}`}>
      <header className="task-detail-panel__header">
        <div>
          <div className="task-detail-panel__chips">
            <Chip tone={isProposal ? "violet" : chipToneForState(task.state)}>
              {isProposal ? "Awaiting approval" : stateLabel(task.state)}
            </Chip>
            {claimantRetired ? (
              <Chip
                tone="crimson"
                title="Still assigned to an agent that is no longer on the canvas"
              >
                Stalled
              </Chip>
            ) : null}
            {isProposal && onApprove ? (
              <Button
                size="xs"
                variant="primary"
                disabled={pending}
                title="Approve this work into the Queue for workers"
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
                title="Reject and remove this pending work from the board"
                onClick={() => onRejectProposal(task)}
              >
                <XCircle size={12} />
                Reject pending work
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
                title={`Clear this assignment and return the task to ${arrivalLaneLabel}`}
                onClick={() => onMove(task, "submitted")}
              >
                <RotateCcw size={12} />
                Unassign to {arrivalLaneLabel}
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
        <span title={isProposal ? "Pending work ID" : "Task ID"}>#{task.id}</span>
        {isProposal || ownerLabel ? (
          <span className="task-detail-panel__claim" title={isProposal ? proposedBy : claim}>
            <UserRound size={12} aria-hidden />
            {isProposal ? (proposedByLabel ?? "Awaiting approval") : ownerLabel}
          </span>
        ) : null}
        {rejectedTimes !== undefined ? (
          <span title="Times returned to Queue after QA rejection">
            QA rejects: {rejectedTimes}
          </span>
        ) : null}
      </div>

      <div className="task-detail-panel__scroll">
        {station}
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

        {isProposal ? null : <TaskJourney task={task} nodeId={nodeId} />}

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

        {isProposal ? (
          <section className="task-detail-panel__section task-detail-panel__status">
            <div>
              <h3>Planning</h3>
              <p>
                This work is waiting for your approval. Approve to place it in the
                queue, reject to discard it, or leave it here until it is ready.
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
                  Reject pending work
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
                  ? "Completed work can go back to the queue through review, or be deleted."
                  : attentionRequired
                  ? "Use this only when the task should leave the response workflow without resuming."
                  : "Move this task to another stage, or delete it."}
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
  const sinkContract = node.ether?.tasks?.contract;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const liveIds = useMemo(() => new Set(items.map((task) => task.id)), [items]);
  const proposalTasks = useMemo(
    () =>
      proposals
        .filter(
          (proposal) =>
            proposal.state === "pending" && !liveIds.has(proposal.id),
        )
        .map(proposalAsDisplayTask),
    [liveIds, proposals],
  );
  const proposalById = useMemo(() => {
    const map = new Map<string, string>();
    for (const proposal of proposals) {
      map.set(proposal.id, proposal.proposedBy.nodeId);
    }
    for (const task of items) {
      if (
        task.state === "submitted" &&
        taskAdmissionState(task, sinkContract, nowMs) === "operator-gated"
      ) {
        map.set(task.id, task.raisedBy?.nodeId ?? "operator");
      }
    }
    return map;
  }, [items, nowMs, proposals, sinkContract]);
  const glance = sinkGlance(items, sinkContract, nowMs);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hideClosed, setHideClosed] = useState(false);
  const [contractSide, setContractSide] = useState<"inbound" | "outbound" | null>(null);
  const [creating, setCreating] = useState<CreateDialogMode | null>(null);
  const [creatingPending, setCreatingPending] = useState(false);
  // Station pins from the creation metro map, cleared each time the composer
  // opens or closes so a stale pin never survives across creation sessions.
  const [creationPins, setCreationPins] = useState<ReadonlyArray<TaskClaim>>([]);
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
  /** Multi-select for column bulk actions (independent of detail focus). */
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
    () => (initialItemId ? new Set([initialItemId]) : new Set()),
  );
  const [bulkPending, setBulkPending] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const api = getVellumCommandApi();
  const name = canvasName();
  const actorRefs = use$(state$.actorRefs);
  const activeActorSeatIds = useMemo(
    () => new Set<string>(actorRefs.map((actor) => actor.seatId)),
    [actorRefs],
  );
  const doc = use$(state$.doc);
  // Columns follow the flow edges: incoming flow turns Awaiting approval + Queue into
  // Inbound, outgoing flow turns Closed into Outbound (spec §7).
  const shape = useMemo(() => pipelineShape(doc, node.id), [doc, node.id]);
  // An operator-owned station never hands work to a seat: the operator answers
  // the claims and routes the work from the detail panel.
  const operatorOwned = resolveSinkAdmission(sinkContract) === "operator-owned";
  const stationName = useMemo(() => {
    const names = new Map(
      doc.nodes.map((entry) => [
        entry.id,
        displayStationName(entry),
      ]),
    );
    return (nodeId: string): string =>
      names.get(nodeId) ?? displayStationName(undefined, nodeId);
  }, [doc]);
  const currentStation = useMemo(
    () => stationIdentity(doc.nodes.find((entry) => entry.id === node.id), node.id),
    [doc, node.id],
  );
  const seatName = useMemo(() => {
    const names = new Map<string, string>(
      actorRefs.map((actor) => [actor.seatId, stationName(actor.nodeId)]),
    );
    return (seatId: string): string | undefined => names.get(seatId);
  }, [actorRefs, stationName]);
  const ownerFor = (task: WorkTask): string | undefined => {
    const owner = currentTaskOwner(task, sinkContract);
    if (owner.kind === "operator") return "Operator";
    if (owner.kind === "seat") return seatName(owner.seatId) ?? owner.seatId;
    return undefined;
  };
  const laneCopy = useMemo(
    () => pipelineLaneCopy(shape, stationName),
    [shape, stationName],
  );
  const inboundContractGlance = useMemo(() => {
    const admission = resolveSinkAdmission(sinkContract);
    const bake = formatBakeTime(sinkContract?.inbound?.claimableAfterMs);
    return {
      admission: `Admission: ${admissionLabel(admission)}`,
      bake: `Bake: ${bake || "none"}`,
    };
  }, [sinkContract]);

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
      proposal: [],
      queue: [],
      inbound: [],
      working: [],
      input: [],
      outbound: [],
      closed: [],
    };
    grouped[shape.hasInbound ? "inbound" : "proposal"].push(
      ...proposalTasks.filter((task) => {
        const normalized = query.trim().toLowerCase();
        return !normalized ||
          taskTitle(task).toLowerCase().includes(normalized) ||
          Boolean(taskDetails(task)?.toLowerCase().includes(normalized));
      }),
    );
    for (const task of visibleItems) {
      grouped[laneForTask(task, shape, sinkContract, nowMs)].push(task);
    }
    // Latest activity first in every lane (Closed especially: complete by latest).
    for (const laneId of Object.keys(grouped) as LaneId[]) {
      grouped[laneId].sort(compareTasksByLatestActivityDesc);
    }
    return grouped;
  }, [nowMs, proposalTasks, query, shape, sinkContract, visibleItems]);

  const outboundGroups = useMemo((): ReadonlyArray<TaskLaneGroup> | undefined => {
    if (!shape.hasOutbound) return undefined;
    return groupOutboundPassages(
      tasksByLane.outbound,
      node.id,
      shape.destinations,
    ).map((group) => ({
      key: group.key,
      kind: group.kind,
      ...(group.stationId !== undefined
        ? { station: stationName(group.stationId) }
        : {}),
      tasks: group.tasks,
    }));
  }, [node.id, shape, stationName, tasksByLane]);

  const activeTask = activeTaskId ? items.find((task) => task.id === activeTaskId) : undefined;
  // Approval candidates are display-mapped WorkTasks (not in items) — resolve
  // both lists so clicking one opens the same detail panel as a normal task.
  const selectedTask = selectedTaskId
    ? (items.find((task) => task.id === selectedTaskId) ??
      proposalTasks.find((task) => task.id === selectedTaskId))
    : undefined;
  const selectedIsProposal =
    selectedTask !== undefined && proposalById.has(selectedTask.id);
  const selectedBulkItems = useMemo(() => {
    if (selectedTaskIds.size === 0) return [];
    const out: Array<{
      task: WorkTask;
      isProposal: boolean;
    }> = [];
    for (const id of selectedTaskIds) {
      const task =
        items.find((entry) => entry.id === id) ??
        proposalTasks.find((entry) => entry.id === id);
      if (!task) continue;
      out.push({ task, isProposal: proposalById.has(task.id) });
    }
    return out;
  }, [items, proposalById, proposalTasks, selectedTaskIds]);
  const bulkActions = useMemo(
    () =>
      resolveTaskBoardBulkActions(
        selectedBulkItems.map(({ task, isProposal }) => ({
          id: task.id,
          state: task.state,
          isProposal,
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

  // Arrival bake countdowns tick only while some arrival is still held.
  const inboundTasks = tasksByLane.inbound;
  useEffect(() => {
    if (!shape.hasInbound || !hasPendingHold(inboundTasks, Date.now())) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (!hasPendingHold(inboundTasks, next)) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [inboundTasks, shape.hasInbound]);

  const createTask = async (
    title: string,
    details: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string> = [],
    finishCriteria?: import("@shared/work-model").FinishCriteria,
    claims: ReadonlyArray<TaskClaim> = [],
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
          claims.length > 0 ? claims : undefined,
          options,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(
        `Created ${title.trim()} in ${laneById(laneForTask(result.data, shape, sinkContract, Date.now())).label}.`,
      );
      setCreating(null);
      setCreationPins([]);
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
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string> = [],
    finishCriteria?: import("@shared/work-model").FinishCriteria,
    claims: ReadonlyArray<TaskClaim> = [],
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
        api.workTaskPropose(
          name,
          node.id,
          title.trim(),
          metadata,
          undefined,
          media.length > 0 ? media : undefined,
          dependsOn.length > 0 ? dependsOn : undefined,
          finishCriteria,
          claims.length > 0 ? claims : undefined,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(`Proposed ${title.trim()} for planning.`);
      setCreating(null);
      setCreationPins([]);
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
        setAnnouncement(`Rejected ${taskTitle(task)} and returned it to Queue.`);
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
      for (const { task, isProposal } of selectedBulkItems) {
        let ok = false;
        if (action.kind === "approve_proposals") {
          if (!isProposal) continue;
          if (!api) {
            failCount += 1;
            continue;
          }
          setPendingTaskId(task.id);
          try {
            const result = await runWorkCanvasMutation(name, () =>
              api.workTaskApproveProposal(name, node.id, task.id),
            );
            ok = result !== undefined && result.ok;
            if (result && !result.ok) lastError = result.message;
          } finally {
            setPendingTaskId(null);
          }
        } else if (action.kind === "reject_proposals") {
          if (!isProposal || !api?.workTaskRejectProposal) continue;
          setPendingTaskId(task.id);
          try {
            const result = await runWorkCanvasMutation(name, () =>
              api.workTaskRejectProposal!(name, node.id, task.id),
            );
            ok = result !== undefined && result.ok;
            if (result && !result.ok) lastError = result.message;
          } finally {
            setPendingTaskId(null);
          }
        } else {
          if (isProposal) continue;
          ok = await transitionTask(task, action.state);
        }
        if (ok) okCount += 1;
        else failCount += 1;
      }
      if (okCount > 0 && failCount === 0) {
        setAnnouncement(`${action.label} — ${okCount} done.`);
        clearTaskSelection();
        if (
          action.kind === "reject_proposals" ||
          (action.kind === "transition" && action.state === "archived")
        ) {
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
      setAnnouncement(`Approved ${taskTitle(task)} into ${INBOUND_LANE.label}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not approve ${taskTitle(task)}. ${message}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  const rejectArrival = async (task: WorkTask, note?: string) => {
    if (!api?.workTaskRejectArrival) {
      setError("Arrival rejection is not available until the current work service is ready.");
      return;
    }
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskRejectArrival(
          name,
          node.id,
          task.id,
          note?.trim() || undefined,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not reject ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setAnnouncement(`Rejected arrival ${taskTitle(task)}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not reject ${taskTitle(task)}. ${message}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  const arrivalMarkFor = (task: WorkTask): ReactNode => {
    if (task.state !== "submitted" || proposalById.has(task.id)) return null;
    const glance = arrivalGlance(task, sinkContract, nowMs);
    return (
      <ArrivalMark
        glance={glance}
        gatedStation={resolveSinkAdmission(sinkContract) === "operator-gated"}
        pending={pendingTaskId === task.id}
        onPromote={
          glance.promotable ? (note) => void promoteTask(task, note) : undefined
        }
        onReject={
          glance.promotable ? (note) => void rejectArrival(task, note) : undefined
        }
      />
    );
  };

  /**
   * Operator completion at a station: the claim answers ride in the completion
   * evidence, `next` names the forward station (absent = terminal close). The
   * work service checks the shape of the submission and re-homes the row.
   */
  const completeAtStation = async (
    task: WorkTask,
    submission: StationSubmission,
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
            ...(submission.responses.length > 0
              ? { responses: submission.responses }
              : {}),
            ...(submission.waivers.length > 0
              ? { claimWaivers: submission.waivers }
              : {}),
          },
          next !== undefined ? { next } : undefined,
        ),
      );
      if (result === undefined) return false;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not route ${taskTitle(task)}. ${result.message}`);
        return false;
      }
      setAnnouncement(
        next === undefined
          ? `Closed ${taskTitle(task)}.`
          : `Forwarded ${taskTitle(task)} to ${stationName(next)}.`,
      );
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not route ${taskTitle(task)}. ${message}`);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  /** Defect back: the row returns to the station it came from, one epoch later. */
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
          : `Sent ${taskTitle(task)} back to ${stationName(target)} as a defect.`,
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
      setAnnouncement(`Removed ${taskTitle(task)} from awaiting approval.`);
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
    const state = destinationState(targetLane);
    if (!state) {
      setAnnouncement("Choose how this task should close.");
      return;
    }
    void transitionTask(task, state);
  };

  const boardLanes = visibleLanes(shape);
  // The closing column is Closed on a plain sink, Outbound on a pipeline sink.
  const closingLaneLabel = (
    shape.hasOutbound ? OUTBOUND_LANE.label : laneById("closed").label
  ).toLowerCase();
  const shownLanes = hideClosed
    ? boardLanes.filter((lane) => lane.id !== "closed" && lane.id !== "outbound")
    : boardLanes;

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
          eyebrow="station"
          title={currentStation.name}
          status={
            <>
              {glance.inFlight} in flight
              {glance.needsInput > 0 ? ` - ${glance.needsInput} need you` : ""}
            </>
          }
          actions={
            <>
              <IconButton
                tone={contractSide ? "accent" : "default"}
                aria-label="Edit station contract"
                title="Edit station contract"
                onClick={() => {
                  setSelectedTaskId(null);
                  setContractSide((current) => (current ? null : "inbound"));
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
                variant="subtle"
                size="sm"
                onClick={() => setCreating("proposal")}
              >
                <Plus size={12} />
                Add for approval
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreating("task")}
                data-testid="task-board-enqueue"
              >
                <Plus size={12} />
                Add task
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

        {/*
          The creation metro map rides above the form: on a sink with flow
          destinations it draws the line the work will travel and the law
          standing at every stop. It returns null for a flowless sink, so Add
          Task there stays the plain quick-create path it always was.
        */}
        {creating ? (
          <TaskCreateDialog
            mode={creating}
            pending={creatingPending}
            artifactsNodeId={resolveArtifactsNodeId(node.id, doc)}
            admissionFloor={resolveSinkAdmission(sinkContract)}
            preamble={
              creating === "task" ? (
                <TaskCreationMetroMap
                  nodeId={node.id}
                  pins={creationPins}
                  onPinsChange={setCreationPins}
                />
              ) : undefined
            }
            onClose={() => {
              if (!creatingPending) {
                setCreating(null);
                setCreationPins([]);
              }
            }}
            onCreate={(title, details, media, dependsOn, finishCriteria, options) => {
              if (creating === "proposal") {
                void createProposal(
                  title,
                  details,
                  media,
                  dependsOn,
                  finishCriteria,
                  creationPins,
                );
                return;
              }
              void createTask(
                title,
                details,
                media,
                dependsOn,
                finishCriteria,
                creationPins,
                options,
              );
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
                      action.kind === "reject_proposals" ||
                      (action.kind === "transition" &&
                        (action.state === "archived" ||
                          action.state === "canceled" ||
                          action.state === "failed" ||
                          action.state === "rejected"))
                        ? "danger"
                        : action.kind === "approve_proposals"
                          ? "primary"
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
                lane={lane}
                lanes={boardLanes}
                tasks={tasksByLane[lane.id]}
                groups={lane.id === "outbound" ? outboundGroups : undefined}
                headerDetail={
                  lane.id === "inbound" ? (
                    <>
                      <span>{inboundContractGlance.admission}</span>
                      <span>{inboundContractGlance.bake}</span>
                    </>
                  ) : lane.id === "outbound" ? (
                    <span>{laneCopy.outboundHint}</span>
                  ) : undefined
                }
                headerAction={
                  lane.id === "inbound" || lane.id === "outbound" ? (
                    <IconButton
                      size="sm"
                      aria-label={`Edit ${lane.id === "inbound" ? "arrivals" : "departures"} contract`}
                      title={`Edit ${lane.id === "inbound" ? "arrivals" : "departures"} contract`}
                      onClick={() => {
                        setSelectedTaskId(null);
                        setContractSide(lane.id === "inbound" ? "inbound" : "outbound");
                      }}
                    >
                      <Settings2 size={13} />
                    </IconButton>
                  ) : undefined
                }
                emptyText={
                  lane.id === "inbound"
                    ? laneCopy.inboundEmpty
                    : lane.id === "outbound"
                      ? laneCopy.outboundEmpty
                      : undefined
                }
                markFor={lane.id === "inbound" ? arrivalMarkFor : undefined}
                allTasks={scopeTasks}
                searchActive={Boolean(query.trim())}
                activeLane={activeLane}
                pendingTaskId={pendingTaskId}
                editingTaskId={editingTaskId}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={selectedTaskIds}
                activeActorSeatIds={activeActorSeatIds}
                proposalById={proposalById}
                ownerFor={ownerFor}
                onCreate={() =>
                  setCreating(lane.id === "proposal" ? "proposal" : "task")
                }
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
              nodeId={node.id}
              lanes={boardLanes}
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
              ownerLabel={ownerFor(selectedTask)}
              seatName={seatName}
              nodeName={stationName}
              station={
                operatorOwned &&
                !selectedIsProposal &&
                !TERMINAL_STATES.has(selectedTask.state) ? (
                  <TaskStationConsole
                    claims={effectiveClaimsStack(doc, node.id, selectedTask)}
                    destinations={shape.destinations.map((destination) => ({
                      id: destination,
                      label: stationName(destination),
                    }))}
                    defectTargets={defectTargetOptions(
                      doc,
                      selectedTask,
                      node.id,
                    ).map((target) => ({
                      id: target.station,
                      label: stationName(target.station),
                      present: target.present,
                    }))}
                    previousStation={
                      selectedTask.journey?.at(-2)?.nodeId
                    }
                    canSendBack={(selectedTask.journey?.length ?? 0) > 1}
                    pending={pendingTaskId === selectedTask.id}
                    onComplete={(submission, next) =>
                      completeAtStation(selectedTask, submission, next)
                    }
                    onSendBack={(summary, refs, stationNote, target) =>
                      sendBackDefect(
                        selectedTask,
                        summary,
                        refs,
                        stationNote,
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
              onComment={commentOnTask}
            />
          ) : null}
          {contractSide ? (
            <TaskContractPanel
              node={node}
              side={contractSide}
              station={stationName(node.id)}
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
