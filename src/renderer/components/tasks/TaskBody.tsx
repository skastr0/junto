import { useEffect, useRef } from "react";
import type { TaskCommand, TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import { LiveMarkdownField, type LiveMarkdownFieldHandle } from "../artifacts/LiveMarkdownField";
import { useTaskBodyMentions } from "./task-body-mentions";

/**
 * A task's body, read and written as live markdown: headings, lists and
 * tables drawn, the caret's lines in source, mentions of seats, tasks and
 * artifacts as chips, an embed line as its preview card, and @ and # to
 * name one. The body stays the task's own text, byte for byte, saved whole
 * through the task's edit, as the title is.
 *
 * Typing is saved when it rests or the field is left. A body that changes
 * elsewhere (an agent's edit) is taken in only while nothing typed is
 * unsaved; with typing unsaved the next save writes over it, as the task's
 * edit always has.
 */
export function TaskBody({
  canvasName,
  node,
  taskId,
  title,
  body,
  all,
  readOnly,
  apply,
}: {
  readonly canvasName: string;
  readonly node: TaskNodeId;
  readonly taskId: TaskId;
  readonly title: string;
  readonly body: string;
  /** Every task of the canvas, for what # may name. */
  readonly all: ReadonlyArray<TaskView>;
  readonly readOnly: boolean;
  readonly apply: (command: TaskCommand) => Promise<string | undefined>;
}) {
  const mentions = useTaskBodyMentions(canvasName, node, taskId, all);
  const field = useRef<LiveMarkdownFieldHandle>(null);
  /** The body as last saved or received: what a rest is compared with. */
  const saved = useRef(body);
  /** What the field holds now. */
  const draft = useRef(body);

  useEffect(() => {
    if (body === saved.current) return;
    const unsaved = draft.current !== saved.current;
    saved.current = body;
    if (unsaved) return;
    draft.current = body;
    field.current?.replace(body);
  }, [body]);

  const save = (text: string): void => {
    if (text === saved.current) return;
    const before = saved.current;
    saved.current = text;
    void apply({ kind: "edit", body: text }).then((refused) => {
      // A refused save keeps the typing and tries again on the next rest; the pane shows why.
      if (refused !== undefined && saved.current === text) saved.current = before;
    });
  };

  // An archived task with nothing written says nothing.
  if (readOnly && body.length === 0) return null;
  return (
    <div className="task-body" data-testid="task-body">
      <LiveMarkdownField
        handle={field}
        value={body}
        readOnly={readOnly}
        mentions={mentions}
        label="Task description"
        surfaceLabel={`${title}, description`}
        placeholder="Describe the task. @ names a seat, # a task or an artifact."
        onChange={(text) => {
          draft.current = text;
        }}
        onRest={save}
      />
    </div>
  );
}
