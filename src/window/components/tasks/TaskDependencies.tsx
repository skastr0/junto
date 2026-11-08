import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { TaskCommand, TaskId, TaskView } from "@shared/task-model";
import { Button, Dropdown, IconButton, ResourceChip } from "../ui";
import { numberLabel } from "./tasks-pane-model";

/**
 * What this task waits on: each dependency as a task chip, and a picker to add
 * one. The ruler refuses a cycle or an unknown task, and the node says why.
 */
export function TaskDependencies({
  view,
  all,
  closed,
  pending = false,
  onCommand,
}: {
  readonly view: TaskView;
  /** Every task of the canvas, to name a dependency and to pick one. */
  readonly all: ReadonlyArray<TaskView>;
  readonly closed: boolean;
  readonly pending?: boolean;
  readonly onCommand: (command: TaskCommand) => Promise<string | undefined> | string | undefined | void;
}) {
  const [adding, setAdding] = useState("");
  const candidates = closed
    ? []
    : all.filter(
        (other) =>
          other.taskId !== view.taskId &&
          !view.dependsOn.includes(other.taskId) &&
          other.current.state !== "archived",
      );
  if (view.dependsOn.length === 0 && candidates.length === 0) return null;
  const find = (id: TaskId): TaskView | undefined => all.find((other) => other.taskId === id);
  return (
    <section className="task-deps" aria-label="Depends on" data-testid="task-deps">
      <header className="task-deps__head">Depends on</header>
      {view.dependsOn.length === 0 ? <p className="task-deps__none">Nothing.</p> : null}
      <ul className="task-deps__list">
        {view.dependsOn.map((id) => {
          const dep = find(id);
          return (
            <li key={id}>
              <ResourceChip kind="task" label={dep?.title ?? "Unavailable"} number={dep?.number} missing={dep === undefined} />
              {closed ? null : (
                <IconButton
                  aria-label={`Stop depending on ${dep === undefined ? "an unavailable task" : dep.title}`}
                  title="Remove dependency"
                  disabled={pending}
                  onClick={() => void onCommand({ kind: "undepend", on: id })}
                >
                  <X size={12} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      {candidates.length > 0 ? (
        <div className="task-deps__add">
          <Dropdown
            aria-label="Add dependency"
            value={adding}
            options={candidates.map((other) => ({
              value: other.taskId,
              label: other.title,
              detail: numberLabel(other),
            }))}
            onChange={setAdding}
            placeholder="Depends on…"
            disabled={pending}
          />
          <Button
            size="xs"
            variant="chrome"
            disabled={pending || adding === ""}
            onClick={() => {
              void onCommand({ kind: "depend", on: adding as TaskId });
              setAdding("");
            }}
          >
            <Plus size={12} aria-hidden />
            Add
          </Button>
        </div>
      ) : null}
    </section>
  );
}
