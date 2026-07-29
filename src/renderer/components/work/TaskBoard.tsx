import { useId, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  Activity,
  CheckCircle2,
  CircleDot,
  Filter,
  GripVertical,
  KeyRound,
  LoaderCircle,
  MessageSquareWarning,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  Reply,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldX,
  UserRound,
  X,
} from "lucide-react";
import {
  DragDropProvider,
  DragOverlay,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { CanvasNode, Part, TaskState, WorkMetadata } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import { sinkGlance, workRoleOf, workRolesInDoc } from "@shared/attention";
import { canTransitionTaskState, claimedByOf, taskBrief } from "@shared/task";
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
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import "./task-board.css";

type Ether = NonNullable<CanvasNode["ether"]>;
type WorkTask = NonNullable<Ether["tasks"]>["items"][number];

type LaneId = "queue" | "working" | "input" | "authorization" | "closed";

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
    id: "authorization",
    label: "Needs authorization",
    state: "auth-required",
    tone: "amber",
    chipTone: "amber",
    icon: KeyRound,
    hint: "Waiting for operator authority",
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

const TERMINAL_STATES = new Set<TaskState>(["completed", "canceled", "failed", "rejected"]);

export const isTaskClaimantRetired = (
  state: TaskState,
  claimedBy: string | undefined,
  activeActorSeatIds: ReadonlySet<string>,
): boolean =>
  claimedBy !== undefined
  && !TERMINAL_STATES.has(state)
  && !activeActorSeatIds.has(claimedBy);

const laneForState = (state: TaskState): LaneId => {
  if (TERMINAL_STATES.has(state)) return "closed";
  if (state === "submitted") return "queue";
  if (state === "working") return "working";
  if (state === "input-required") return "input";
  return "authorization";
};

const stateLabel = (state: TaskState): string => {
  switch (state) {
    case "submitted":
      return "Queued";
    case "working":
      return "Working";
    case "input-required":
      return "Input needed";
    case "auth-required":
      return "Authorization needed";
    case "completed":
      return "Completed";
    case "canceled":
      return "Canceled";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
  }
};

const toneForState = (state: TaskState): StatusTone => {
  if (state === "working") return "cyan";
  if (state === "completed") return "green";
  if (state === "failed" || state === "rejected") return "crimson";
  if (state === "canceled") return "dim";
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
  searchActive,
  activeLane,
  pendingTaskId,
  editingTaskId,
  selectedTaskId,
  activeActorSeatIds,
  onCreate,
  onSelect,
  onMove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly lane: LaneDefinition;
  readonly tasks: ReadonlyArray<WorkTask>;
  readonly searchActive: boolean;
  readonly activeLane: LaneId | null;
  readonly pendingTaskId: string | null;
  readonly editingTaskId: string | null;
  readonly selectedTaskId: string | null;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly onCreate: () => void;
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
        lane.id === "input" || lane.id === "authorization" ? "task-board-lane--attention" : "",
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
        {lane.id === "queue" ? (
          <IconButton
            size="sm"
            tone="accent"
            aria-label="Create task in Queue"
            title="Create task"
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
            lane={lane}
            index={index}
            pending={pendingTaskId === task.id}
            editing={editingTaskId === task.id}
            selected={selectedTaskId === task.id}
            activeActorSeatIds={activeActorSeatIds}
            onSelect={onSelect}
            onMove={onMove}
            onEdit={onEdit}
            onCancelEdit={onCancelEdit}
            onSaveEdit={onSaveEdit}
          />
        ))}
        {tasks.length === 0 ? (
          <div className="task-board-lane__empty">
            <span>{searchActive ? "No matching tasks" : `No tasks ${lane.label.toLowerCase()}`}</span>
            {lane.id === "queue" && !searchActive ? (
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

function TaskActionsMenu({
  task,
  lane,
  pending,
  onEdit,
  onMove,
}: {
  readonly task: WorkTask;
  readonly lane: LaneDefinition;
  readonly pending: boolean;
  readonly onEdit: (task: WorkTask) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
}) {
  const menuId = `task-actions-${useId().replaceAll(":", "")}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const brief = taskTitle(task);
  const availableMoves = LANES.filter(
    (destination) =>
      destination.state &&
      destination.id !== lane.id &&
      canTransitionTaskState(task.state, destination.state),
  );
  const terminalActions = (
    [
      ["completed", "Complete task"],
      ["failed", "Mark as failed"],
      ["rejected", "Reject task"],
      ["canceled", "Cancel task"],
    ] as const
  ).filter(([state]) => canTransitionTaskState(task.state, state));

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
        <button type="button" role="menuitem" onClick={() => commit(() => onEdit(task))}>
          Edit title
        </button>
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
  lane,
  index,
  pending,
  editing,
  selected,
  activeActorSeatIds,
  onSelect,
  onMove,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly task: WorkTask;
  readonly lane: LaneDefinition;
  readonly index: number;
  readonly pending: boolean;
  readonly editing: boolean;
  readonly selected: boolean;
  readonly activeActorSeatIds: ReadonlySet<string>;
  readonly onSelect: (taskId: string) => void;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
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
    disabled: TERMINAL_STATES.has(task.state) || pending,
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
      data-draggable={TERMINAL_STATES.has(task.state) || pending ? "false" : "true"}
      data-testid="task-board-card"
      role="listitem"
      tabIndex={0}
      aria-busy={pending}
      aria-label={`Open details for ${brief}${
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
          title={TERMINAL_STATES.has(task.state) ? "Closed tasks cannot move" : "Drag task"}
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
                <span title={claim}>{claim ?? "Unclaimed"}</span>
                {role ? <span className="task-board-card__role">{role}</span> : null}
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
            onEdit={onEdit}
            onMove={onMove}
          />
        ) : null}
      </div>

      {!editing ? (
        <footer className="task-board-card__footer">
          <div className="task-board-card__status-chips">
            <Chip tone={chipToneForState(task.state)}>{stateLabel(task.state)}</Chip>
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
            <span>{claimedByOf(task) ?? "Unclaimed"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskCreateDialog({
  roles,
  pending,
  onClose,
  onCreate,
}: {
  readonly roles: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onCreate: (title: string, details: string, role: string) => void;
}) {
  const roleListId = `task-role-options-${useId().replaceAll(":", "")}`;
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [role, setRole] = useState("");

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="work"
      label="Create task"
      onClose={onClose}
      closeOnBackdrop={!pending}
      closeOnEscape={!pending}
      panelClassName="task-create-dialog"
    >
      <OverlayHeader
        eyebrow="new task"
        title="Define the work"
        status="Give the worker enough context to act without guessing."
        actions={
          <IconButton aria-label="Close task creator" title="Close" onClick={onClose} disabled={pending}>
            <X size={14} />
          </IconButton>
        }
      />
      <form
        className="task-create-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) onCreate(title.trim(), details.trim(), role.trim());
        }}
      >
        <label>
          <span>Title</span>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            maxLength={180}
          />
          <small>A concise outcome that stays readable on the board.</small>
        </label>
        <label>
          <span>Task role</span>
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
          <small>The specialization this task should be routed to.</small>
        </label>
        <label>
          <span>Description</span>
          <Textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Describe the context, constraints, expected result, and any proof the worker should return…"
            rows={9}
          />
          <small>Long-form is welcome. Line breaks and detailed acceptance notes are preserved.</small>
        </label>
        <footer>
          <Button type="button" variant="subtle" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !title.trim()}>
            {pending ? "Creating…" : "Create task"}
          </Button>
        </footer>
      </form>
    </FocusSurface>
  );
}

function TaskDetailPanel({
  task,
  pending,
  claimantRetired,
  onClose,
  onSaveTitle,
  onRespond,
  onMove,
}: {
  readonly task: WorkTask;
  readonly pending: boolean;
  readonly claimantRetired: boolean;
  readonly onClose: () => void;
  readonly onSaveTitle: (task: WorkTask, title: string) => void;
  readonly onRespond: (
    task: WorkTask,
    response: string,
    disposition: "working" | "rejected",
  ) => Promise<boolean>;
  readonly onMove: (task: WorkTask, state: TaskState) => void;
}) {
  const [title, setTitle] = useState(() => taskTitle(task));
  const [response, setResponse] = useState("");
  const role = taskRole(task);
  const claim = claimedByOf(task);
  const details = taskDetails(task);
  const attentionRequired = task.state === "input-required" || task.state === "auth-required";
  const authorizationRequired = task.state === "auth-required";
  const requestContext = latestText(task);
  const transitionOptions = [
    ...LANES.flatMap((lane) =>
      lane.state && canTransitionTaskState(task.state, lane.state)
        ? [{ value: lane.state, label: `Move to ${lane.label}` }]
        : [],
    ),
    ...(
      [
        ["completed", "Complete task"],
        ["failed", "Mark as failed"],
        ["rejected", "Reject task"],
        ["canceled", "Cancel task"],
      ] as const
    ).flatMap(([state, label]) =>
      canTransitionTaskState(task.state, state) &&
      !LANES.some((lane) => lane.state === state)
        ? [{ value: state, label }]
        : [],
    ),
  ];

  return (
    <aside className="task-detail-panel" aria-label={`Details for ${taskTitle(task)}`}>
      <header className="task-detail-panel__header">
        <div>
          <div className="task-detail-panel__chips">
            <Chip tone={chipToneForState(task.state)}>{stateLabel(task.state)}</Chip>
            {claimantRetired ? (
              <Chip
                tone="crimson"
                title="This task remains claimed, but its ActorSeatId is absent from the current actor projection."
              >
                Stalled · retired seat
              </Chip>
            ) : null}
            {claim && canTransitionTaskState(task.state, "submitted") ? (
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
        <span title="Task ID">#{task.id}</span>
        <span className="task-detail-panel__claim" title={claim}>
          <UserRound size={12} aria-hidden />
          {claim ?? "Unclaimed"}
        </span>
        <span>{role ?? "No task role"}</span>
      </div>

      <div className="task-detail-panel__scroll">
        {attentionRequired ? (
          <section
            className={`task-detail-panel__attention ${
              authorizationRequired ? "is-authorization" : "is-input"
            }`}
            aria-labelledby={`task-response-${task.id}`}
          >
            <div className="task-detail-panel__attention-heading">
              <span className="task-detail-panel__attention-icon" aria-hidden>
                {authorizationRequired ? (
                  <KeyRound size={15} />
                ) : (
                  <MessageSquareWarning size={15} />
                )}
              </span>
              <div>
                <p>{authorizationRequired ? "Operator decision" : "Operator response"}</p>
                <h3 id={`task-response-${task.id}`}>
                  {authorizationRequired ? "Authorization required" : "Input required"}
                </h3>
              </div>
            </div>

            <div className="task-detail-panel__request-context">
              <span>{authorizationRequired ? "Requested action" : "Worker is waiting on"}</span>
              <p>
                {requestContext ??
                  (authorizationRequired
                    ? "The worker needs your approval to proceed."
                    : "The worker asked for more context before continuing.")}
              </p>
            </div>

            <label className="task-detail-panel__response-field">
              <span>{authorizationRequired ? "Decision note" : "Your response"}</span>
              <Textarea
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                placeholder={
                  authorizationRequired
                    ? "Record constraints, scope, or the reason for this decision…"
                    : "Give the worker the context, decision, or answer needed to continue…"
                }
                rows={5}
              />
            </label>

            <div className="task-detail-panel__response-actions">
              {authorizationRequired ? (
                <>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending || !response.trim()}
                    onClick={async () => {
                      if (await onRespond(task, response.trim(), "rejected")) setResponse("");
                    }}
                  >
                    <ShieldX size={13} />
                    Deny request
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={pending || !response.trim()}
                    onClick={async () => {
                      if (await onRespond(task, response.trim(), "working")) setResponse("");
                    }}
                  >
                    <ShieldCheck size={13} />
                    Authorize &amp; resume
                  </Button>
                </>
              ) : (
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
              )}
            </div>

          </section>
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

        <section className="task-detail-panel__section task-detail-panel__status">
          <div>
            <h3>{attentionRequired ? "Other status changes" : "Status"}</h3>
            <p>
              {attentionRequired
                ? "Use this only when the task should leave the response workflow without resuming."
                : "Move this task to another valid stage in its lifecycle."}
            </p>
          </div>
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
  const glance = sinkGlance(items);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hideClosed, setHideClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingPending, setCreatingPending] = useState(false);
  const [roleDraft, setRoleDraft] = useState(workRoleOf(node) ?? "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeLane, setActiveLane] = useState<LaneId | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    if (initialItemId && items.some((task) => task.id === initialItemId)) {
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
      queue: [],
      working: [],
      input: [],
      authorization: [],
      closed: [],
    };
    for (const task of visibleItems) grouped[laneForState(task.state)].push(task);
    return grouped;
  }, [visibleItems]);

  const activeTask = activeTaskId ? items.find((task) => task.id === activeTaskId) : undefined;
  const selectedTask = selectedTaskId
    ? items.find((task) => task.id === selectedTaskId)
    : undefined;
  const knownRoles = workRolesInDoc(state$.doc.peek());

  const createTask = async (title: string, details: string, role: string) => {
    if (!api || !title.trim()) return;
    setError("");
    setCreatingPending(true);
    try {
      const metadata: WorkMetadata = {
        title: title.trim(),
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(role.trim() ? { workRole: role.trim() } : {}),
      };
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskCreate(name, node.id, title.trim(), metadata),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAnnouncement(`Created ${title.trim()} in Queue.`);
      setCreating(false);
      setSelectedTaskId(result.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingPending(false);
    }
  };

  const transitionTask = async (task: WorkTask, state: TaskState) => {
    if (!api || task.state === state) return;
    setError("");
    setPendingTaskId(task.id);
    try {
      const result = await runWorkCanvasMutation(name, () =>
        api.workTaskTransition(name, node.id, task.id, state),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        setAnnouncement(`Could not move ${taskTitle(task)}. ${result.message}`);
        return;
      }
      setAnnouncement(`Moved ${taskTitle(task)} to ${stateLabel(state)}.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setAnnouncement(`Could not move ${taskTitle(task)}. ${message}`);
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
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={12} />
                New task
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
            roles={knownRoles}
            pending={creatingPending}
            onClose={() => {
              if (!creatingPending) setCreating(false);
            }}
            onCreate={(title, details, role) => void createTask(title, details, role)}
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
                searchActive={Boolean(query.trim())}
                activeLane={activeLane}
                pendingTaskId={pendingTaskId}
                editingTaskId={editingTaskId}
                selectedTaskId={selectedTaskId}
                activeActorSeatIds={activeActorSeatIds}
                onCreate={() => setCreating(true)}
                onSelect={setSelectedTaskId}
                onMove={(task, state) => void transitionTask(task, state)}
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
              claimantRetired={isTaskClaimantRetired(
                selectedTask.state,
                claimedByOf(selectedTask),
                activeActorSeatIds,
              )}
              onClose={() => setSelectedTaskId(null)}
              onSaveTitle={(task, title) => void saveTaskTitle(task, title)}
              onRespond={respondToTask}
              onMove={(task, state) => void transitionTask(task, state)}
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
