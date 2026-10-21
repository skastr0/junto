import { useMemo, useState } from "react";
import { Link2, X } from "lucide-react";
import type { ItemId } from "@shared/resource-command";
import type { TaskView } from "@shared/task-model";
import { Combobox, IconButton, ResourceChip } from "../ui";

/**
 * The tasks an artifact names (05 associations), as chips that open the
 * task, and a picker to name another. A task the canvas no longer lists
 * (finished, or on another machine's view) keeps its chip by id.
 */
export function ArtifactTasks({
  taskIds,
  tasks,
  readOnly,
  onChange,
  onOpen,
}: {
  readonly taskIds: ReadonlyArray<ItemId>;
  /** The canvas's tasks, to name and to pick from. */
  readonly tasks: ReadonlyArray<TaskView>;
  readonly readOnly: boolean;
  readonly onChange: (taskIds: ReadonlyArray<ItemId>) => void;
  readonly onOpen: (task: TaskView) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.taskId as string, task])), [tasks]);
  const offered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        !taskIds.includes(task.taskId) &&
        (needle.length === 0 ||
          task.title.toLowerCase().includes(needle) ||
          (task.number !== undefined && String(task.number).startsWith(needle.replace(/^#/u, "")))),
    );
  }, [tasks, taskIds, query]);

  const link = (task: TaskView | undefined): void => {
    if (task === undefined) return;
    onChange([...taskIds, task.taskId]);
    setQuery("");
    setPicking(false);
  };

  if (taskIds.length === 0 && (readOnly || !picking)) {
    return readOnly ? null : (
      <div className="artifact-tasks">
        <IconButton size="sm" aria-label="Name a task" title="Name a task" onClick={() => setPicking(true)}>
          <Link2 size={13} />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="artifact-tasks" role="group" aria-label="Tasks">
      {taskIds.map((taskId) => {
        const task = byId.get(taskId);
        return (
          <span key={taskId} className="artifact-tasks__chip">
            <ResourceChip
              kind="task"
              label={task?.title ?? `Task ${taskId.slice(-6)}`}
              {...(task?.number === undefined ? {} : { number: task.number })}
              {...(task === undefined ? {} : { onOpen: () => onOpen(task) })}
            />
            {readOnly ? null : (
              <IconButton
                size="xs"
                aria-label={`Unlink ${task?.title ?? "task"}`}
                title="Unlink"
                onClick={() => onChange(taskIds.filter((id) => id !== taskId))}
              >
                <X size={11} />
              </IconButton>
            )}
          </span>
        );
      })}
      {readOnly ? null : picking ? (
        <div className="artifact-tasks__picker">
          <Combobox
            value={query}
            onValueChange={setQuery}
            options={offered}
            optionKey={(task) => task.taskId}
            renderOption={(task) => (
              <ResourceChip kind="task" label={task.title} {...(task.number === undefined ? {} : { number: task.number })} />
            )}
            activeKey={active}
            onActiveKeyChange={setActive}
            onCommit={(task) => link(task)}
            onOptionClick={link}
            aria-label="Find a task"
            listLabel="Tasks"
            placeholder="Find a task"
            empty={<span className="artifact-tasks__none">No task to name.</span>}
            trailing={
              <IconButton size="xs" aria-label="Cancel" title="Cancel" onClick={() => setPicking(false)}>
                <X size={11} />
              </IconButton>
            }
          />
        </div>
      ) : (
        <IconButton size="sm" aria-label="Name a task" title="Name a task" onClick={() => setPicking(true)}>
          <Link2 size={13} />
        </IconButton>
      )}
    </div>
  );
}
