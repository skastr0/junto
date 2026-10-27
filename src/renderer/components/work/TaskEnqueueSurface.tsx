import { useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Minus, Plus, X } from "lucide-react";
import { asNodeId } from "@shared/model";
import { mintItemId } from "@shared/resource-command";
import { STAMPS_REQUIRED_MAX, taskNodeId } from "@shared/task-model";
import type { WorkSurface } from "../../lib/surface-registry";
import { closeWorkbenchSurface, dock$ } from "../../lib/dock-state";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";
import { state$ } from "../../lib/state";
import { useNodeOf } from "../../lib/use-model";
import { tasksSource, useCanvasTasks } from "../../lib/tasks-source";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { LiveMarkdownField } from "../artifacts/LiveMarkdownField";
import { useTaskBodyMentions } from "../tasks/task-body-mentions";
import { Button, IconButton, Input } from "../ui";
import "./task-enqueue.css";

/**
 * Workbench pane: quick enqueue for a task node. A title, what it is about,
 * and how many approvals finishing needs; the task lands in the node's
 * backlog. Coexists with a terminal in a split. A created task clears the
 * form and keeps the pane open for the next one.
 *
 * What it is about is written as the task pane reads it: live markdown,
 * with @ and # to name seats, tasks and artifacts in reach.
 */
export function TaskEnqueueSurface({
  surface,
  visible,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly visible: boolean;
  readonly onActivate: () => void;
}) {
  const payload = use$(dock$.taskCreateById[surface.id]);
  const nodeId = payload?.nodeId;
  const name = use$(state$.canvasName);
  const node = useNodeOf(name, nodeId ?? "", "task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  /** A new one each time the form clears, so the details field opens empty. */
  const [written, setWritten] = useState(0);
  const all = useCanvasTasks(name);
  const mentions = useTaskBodyMentions(name, taskNodeId(asNodeId(nodeId ?? "")), undefined, all);
  const [required, setRequired] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!payload || !node || nodeId === undefined) {
    return (
      <section className="dock-slot workbench-surface">
        <div className="workbench-surface__placeholder">task enqueue - unbound</div>
      </section>
    );
  }

  const ready = title.trim().length > 0 && !pending;
  const create = async (): Promise<void> => {
    if (!ready) return;
    setError("");
    setPending(true);
    try {
      const taskId = mintItemId();
      const ruling = await tasksSource().apply(name, taskNodeId(asNodeId(nodeId)), taskId, {
        kind: "create",
        taskId,
        title: title.trim(),
        ...(details.trim() === "" ? {} : { body: details.trim() }),
        stampPolicy: { required },
      });
      if (!ruling.ok) {
        setError(ruling.message);
        return;
      }
      setTitle("");
      setDetails("");
      setWritten((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="dock-slot dock-slot--task-create workbench-surface task-enqueue"
      aria-label={`Quick enqueue - ${payload.title}`}
      aria-hidden={!visible}
      data-focus-owner="interactive"
      data-testid="task-enqueue-surface"
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      <header className="task-enqueue__head">
        <span>New task on {payload.title}</span>
        <IconButton
          size="md"
          tone="danger"
          aria-label="Close task enqueue"
          title="Close"
          onClick={() => closeWorkbenchSurface(surface.id)}
          disabled={pending}
        >
          <X size={14} />
        </IconButton>
      </header>
      {error ? (
        <p className="task-enqueue__error" role="alert">
          {error}
        </p>
      ) : null}
      <form
        className="task-enqueue__form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Input
          ref={claimFocusOnMount}
          aria-label="Task title"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <LiveMarkdownField
          key={written}
          className="task-enqueue__details"
          value=""
          readOnly={pending}
          mentions={mentions}
          label="Details"
          surfaceLabel={`New task on ${payload.title}, details`}
          placeholder="Context, constraints, expected result. @ names a seat, # a task or an artifact."
          onChange={setDetails}
        />
        <div className="task-enqueue__review">
          <span>Approvals needed to finish</span>
          <IconButton
            aria-label="Require one fewer approval"
            title="Require one fewer approval"
            disabled={pending || required <= 0}
            onClick={() => setRequired(required - 1)}
          >
            <Minus size={12} />
          </IconButton>
          <output aria-label="Approvals required">{required}</output>
          <IconButton
            aria-label="Require one more approval"
            title="Require one more approval"
            disabled={pending || required >= STAMPS_REQUIRED_MAX}
            onClick={() => setRequired(required + 1)}
          >
            <Plus size={12} />
          </IconButton>
        </div>
        <Button type="submit" size="md" variant="primary" disabled={!ready}>
          Add task
        </Button>
      </form>
    </section>
  );
}
