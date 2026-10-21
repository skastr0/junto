import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Settings2 } from "lucide-react";
import { mintItemId } from "@shared/resource-command";
import type { TaskPendingWrite } from "@shared/resource-ipc";
import type { TaskCommand, TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import { tasksSource, useCanvasTasks, useNodePending, useNodeTasks, useTaskFacts } from "../../lib/tasks-source";
import { type SeatChoice } from "../../lib/task-ui";
import { claimFocusOnMount, releaseFocus } from "../../lib/focus-ownership";
import { FocusSurface } from "../FocusSurface";
import { BoardSettings } from "../rules/BoardSettings";
import {
  Button,
  IconButton,
  Input,
  ListRow,
  PaneEmpty,
  PaneHeader,
  ResourceChip,
  ResourceGlyphMark,
  TaskStateMark,
  TwoPane,
} from "../ui";
import { TaskReviewers } from "../work/TaskReviewers";
import { TaskVerbBar } from "../work/TaskVerbBar";
import { TaskDependencies } from "./TaskDependencies";
import { TaskEvidence } from "./TaskEvidence";
import { TaskThread } from "./TaskThread";
import { TaskLayers } from "./TaskLayers";
import {
  agoLabel,
  listedTasks,
  numberLabel,
  numberOfTask,
  openCount,
  pendingByTask,
  queuedCreates,
  queuedWords,
  taskContextFor,
  visibleTasks,
  type StateFilter,
  type TaskCanvasFacts,
} from "./tasks-pane-model";
import "./tasks.css";

const OPERATOR = { kind: "operator" } as const;
const CLOCK_MS = 60_000;

const FILTERS: ReadonlyArray<{ readonly value: StateFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "backlog", label: "Backlog" },
  { value: "closed", label: "Closed" },
];

/**
 * The Tasks node (04): the node's tasks in a sidebar, the selected one in the
 * main pane with the verbs its state allows, its reviewers and stamps, and
 * the layers it passed through. Every write is one task command, ruled as the
 * editing machine rules it; a refusal is said in place and nothing is lost.
 * What shows as a button is what the ruler would admit.
 */
export function TasksNode({
  canvasName,
  node,
  initialTaskId,
  seats,
  nodeName,
  seatLabel = (id) => id,
  onClose,
}: {
  readonly canvasName: string;
  readonly node: TaskNodeId;
  readonly initialTaskId?: string;
  /** Seats in reach of this node (region reach, 01), named. */
  readonly seats: ReadonlyArray<SeatChoice>;
  readonly nodeName: (node: string) => string;
  /** What a seat that is not among `seats` is called: one out of reach, or removed from the canvas. */
  readonly seatLabel?: (id: string) => string;
  readonly onClose: () => void;
}) {
  const tasks = useNodeTasks(canvasName, node);
  const all = useCanvasTasks(canvasName);
  const facts = useTaskFacts(canvasName);
  const writes = useNodePending(canvasName, node);
  const queued = useMemo(() => pendingByTask(writes), [writes]);
  const queuedNew = useMemo(() => queuedCreates(tasks, writes), [tasks, writes]);
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  // Opened again on another task while this pane is up (a mention chip): follow it.
  useEffect(() => {
    if (initialTaskId !== undefined && initialTaskId !== "") setSelectedId(initialTaskId);
  }, [initialTaskId]);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useClock();

  const visible = useMemo(() => visibleTasks(tasks, { state: filter, query }), [tasks, filter, query]);
  const selected = tasks.find((view) => view.taskId === selectedId) ?? visible[0] ?? null;
  const listed = useMemo(() => listedTasks(visible, selected), [visible, selected]);
  const seatName = (id: string): string => seats.find((seat) => seat.node === id)?.name ?? seatLabel(id);

  const apply = async (taskId: TaskId, command: TaskCommand): Promise<string | undefined> => {
    const ruling = await tasksSource().apply(canvasName, node, taskId, command);
    const line = ruling.ok ? undefined : ruling.message;
    setError(line ?? null);
    setNotice(ruling.ok && ruling.deliveryError !== undefined ? ruling.deliveryError : null);
    return line;
  };

  const create = async (title: string): Promise<void> => {
    const taskId = mintItemId() as TaskId;
    const refused = await apply(taskId, { kind: "create", taskId, title });
    if (refused === undefined) {
      setSelectedId(taskId);
      setFilter("all");
      setCreating(false);
    }
  };

  const sidebar = (
    <>
      <PaneHeader
        eyebrow={`Tasks, ${openCount(tasks)} open`}
        actions={
          <>
            <IconButton
              aria-label="Board settings"
              title="Board settings: instructions, rules, checks, handoff"
              size="sm"
              aria-pressed={settings}
              onClick={() => setSettings(!settings)}
            >
              <Settings2 size={14} />
            </IconButton>
            <IconButton
              aria-label="New task"
              title="New task"
              size="sm"
              aria-expanded={creating}
              onClick={() => setCreating(!creating)}
            >
              <Plus size={14} />
            </IconButton>
          </>
        }
      />
      {creating ? <NewTaskForm onCancel={() => setCreating(false)} onCreate={(title) => void create(title)} /> : null}
      <div className="tasks-filter">
        <label className="tasks-filter__search">
          <Search size={12} aria-hidden />
          <Input dense aria-label="Search tasks" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="tasks-filter__states" role="radiogroup" aria-label="Show">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={filter === option.value}
              className="tasks-filter__state"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="tasks-list" role="list" aria-label="Tasks">
        {queuedNew.map((entry) => (
          <ListRow
            key={entry.taskId}
            leading={<TaskStateMark state="backlog" pending />}
            title={entry.title}
            meta="queued"
            pending
          />
        ))}
        {listed.map((view) => {
          const waits = view.pending !== undefined || queued.has(view.taskId);
          return (
            <ListRow
              key={view.taskId}
              leading={<TaskStateMark state={view.current.state} pending={waits} />}
              title={view.title}
              meta={numberLabel(view)}
              selected={view.taskId === selected?.taskId}
              pending={waits}
              onClick={() => setSelectedId(view.taskId)}
            />
          );
        })}
        {listed.length === 0 && queuedNew.length === 0 && tasks.length > 0 ? <p className="tasks-list__none">No task matches.</p> : null}
      </div>
    </>
  );

  return (
    <FocusSurface measure="workspace" height="immersive" label="Tasks" onClose={onClose}>
      {settings ? (
        <TwoPane sidebar={sidebar} sidebarLabel="Tasks" mainLabel="Board settings">
          <section className="tasks-settings" data-testid="tasks-settings">
            <header className="tasks-settings__head">Board settings</header>
            <BoardSettings nodeId={node} />
          </section>
        </TwoPane>
      ) : selected === null ? (
        <TwoPane sidebar={sidebar} sidebarLabel="Tasks" mainLabel="Task">
          <PaneEmpty
            glyph={<ResourceGlyphMark kind="task" size={20} />}
            title={tasks.length === 0 ? "No tasks yet" : "Pick a task"}
            hint={tasks.length === 0 ? "A task is who is doing what, and who has looked at it." : undefined}
            action={
              tasks.length === 0 ? (
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  New task
                </Button>
              ) : undefined
            }
          />
        </TwoPane>
      ) : (
        <TwoPane sidebar={sidebar} sidebarLabel="Tasks" mainLabel={selected.title}>
          <SelectedTask
            key={selected.taskId}
            canvasName={canvasName}
            view={selected}
            all={all}
            seats={seats}
            facts={facts}
            nodeName={nodeName}
            seatName={seatName}
            now={now}
            error={error}
            notice={notice}
            queued={queued.get(selected.taskId) ?? []}
            apply={(command) => apply(selected.taskId, command)}
          />
        </TwoPane>
      )}
    </FocusSurface>
  );
}

/** The selected task: its head, verbs, reviewers and layers. */
export function SelectedTask({
  canvasName,
  view,
  all,
  seats,
  facts,
  nodeName,
  seatName,
  now,
  error,
  notice = null,
  queued = [],
  apply,
}: {
  readonly canvasName: string;
  readonly view: TaskView;
  readonly all: ReadonlyArray<TaskView>;
  readonly seats: ReadonlyArray<SeatChoice>;
  readonly facts: TaskCanvasFacts;
  readonly nodeName: (node: string) => string;
  readonly seatName: (id: string) => string;
  readonly now: number;
  readonly error: string | null;
  /** A write that stands but whose mail did not go. */
  readonly notice?: string | null;
  /** This machine's queued writes to this task, not yet ruled. */
  readonly queued?: ReadonlyArray<TaskPendingWrite>;
  readonly apply: (command: TaskCommand) => Promise<string | undefined>;
}) {
  const { current } = view;
  const [title, setTitle] = useState(view.title);
  useEffect(() => setTitle(view.title), [view.title]);
  const ctx = taskContextFor(view, all, facts, now);
  const archived = current.state === "archived";
  const isClosed = current.state === "done" || current.state === "canceled" || archived;

  const retitle = (): void => {
    const next = title.trim();
    if (next.length === 0 || next === view.title) {
      setTitle(view.title);
      return;
    }
    void apply({ kind: "edit", title: next });
  };

  return (
    <div className="task-detail" data-testid="task-detail">
      <header className="task-head">
        <span className="task-head__number" title="Task number">
          {numberLabel(view)}
        </span>
        <input
          className="task-head__title"
          aria-label="Title"
          value={title}
          readOnly={archived}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={retitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") releaseFocus(event.currentTarget, "gesture");
            if (event.key === "Escape") setTitle(view.title);
          }}
        />
        <TaskStateMark state={current.state} withLabel pending={view.pending !== undefined} />
      </header>
      <div className="task-facts">
        {current.assignee === undefined ? (
          <span className="task-facts__none">No assignee</span>
        ) : (
          <ResourceChip kind="seat" seat={current.assignee} label={seatName(current.assignee)} />
        )}
        <span className="task-facts__meta">on {nodeName(current.node)}, updated {agoLabel(view.updatedAt, now)}</span>
      </div>
      {error ? (
        <p className="task-error" role="alert">
          {error}
        </p>
      ) : null}
      {queued.length > 0 ? (
        <div className="task-queued" role="status" data-testid="task-queued">
          <span>Waiting to be ruled</span>
          <ul>
            {queued.map((write) => (
              <li key={write.opId}>{queuedWords(write.command, seatName)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {notice ? (
        <p className="task-notice" role="status" data-testid="task-notice">
          It was done, but its mail did not go: {notice}. Do not do it again.
        </p>
      ) : null}
      <TaskVerbBar
        task={current}
        actor={OPERATOR}
        ctx={ctx}
        seats={seats}
        numberOf={(taskId) => numberOfTask(all, taskId)}
        nodeName={nodeName}
        onCommand={apply}
      />
      {view.body ? <p className="task-body">{view.body}</p> : null}
      <TaskDependencies view={view} all={all} closed={isClosed} onCommand={apply} />
      <TaskReviewers task={current} actor={OPERATOR} ctx={ctx} seats={seats} nameOf={seatName} onCommand={apply} />
      <TaskEvidence canvasName={canvasName} evidence={current.evidence} handoff={current.handoff} />
      <TaskThread canvasName={canvasName} node={current.node} taskId={view.taskId} all={all} now={now} seatName={(id) => seatName(id)} />
      <TaskLayers canvasName={canvasName} layers={view.layers} nodeName={nodeName} seats={seats} nameOf={seatName} now={now} />
    </div>
  );
}

function NewTaskForm({
  onCreate,
  onCancel,
}: {
  readonly onCreate: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const ready = title.trim().length > 0;
  return (
    <form
      className="tasks-new"
      aria-label="New task"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onCreate(title.trim());
      }}
    >
      <Input dense ref={claimFocusOnMount} aria-label="Task title" placeholder="What needs doing" value={title} onChange={(event) => setTitle(event.target.value)} />
      <div className="tasks-new__actions">
        <Button size="xs" variant="subtle" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" type="submit" disabled={!ready}>
          Add task
        </Button>
      </div>
    </form>
  );
}

const useClock = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
};
