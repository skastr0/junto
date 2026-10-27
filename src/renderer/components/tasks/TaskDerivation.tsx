import type { TaskLink, TaskView } from "@shared/task-model";
import { openWorkDetail } from "../../lib/work-detail-open";
import { ResourceChip } from "../ui";

/**
 * Where a task came from and what came from it: the origin it was derived
 * from, and the tasks derived from it, each a chip that opens that task. A
 * derived task holds only its title and this link to its origin.
 */
export function TaskDerivation({ view, all }: { readonly view: TaskView; readonly all: ReadonlyArray<TaskView> }) {
  const { derivedFrom, derived } = view;
  if (derivedFrom === undefined && (derived === undefined || derived.length === 0)) return null;
  const chip = (link: TaskLink) => {
    const known = all.find((other) => other.taskId === link.taskId);
    return (
      <ResourceChip
        kind="task"
        label={known?.title ?? (link.number === undefined ? "Unavailable" : `Task ${link.number}`)}
        {...(link.number === undefined ? {} : { number: link.number })}
        onOpen={() => openWorkDetail(link.node, { itemId: link.taskId })}
      />
    );
  };
  return (
    <>
      {derivedFrom === undefined ? null : (
        <section className="task-deps" aria-label="Derived from" data-testid="task-derived-from">
          <header className="task-deps__head">Derived from</header>
          <ul className="task-deps__list">
            <li>{chip(derivedFrom)}</li>
          </ul>
        </section>
      )}
      {derived === undefined || derived.length === 0 ? null : (
        <section className="task-deps" aria-label="Derived tasks" data-testid="task-derived">
          <header className="task-deps__head">Derived tasks</header>
          <ul className="task-deps__list">
            {derived.map((link) => (
              <li key={link.taskId}>{chip(link)}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
