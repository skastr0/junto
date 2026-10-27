import { useNodeArtifacts } from "../../lib/artifacts-source";
import { useAutomations } from "../../lib/automations-source";
import { useWorkMail } from "../../lib/use-work-mail";
import { type CSSProperties, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { Plus, Workflow } from "lucide-react";
import type { Part } from "@shared/work-model";
import { TASKS_ENABLED } from "@shared/features";
import { taskBoardTitle } from "@shared/model/title";
import { renamed } from "../../lib/model-edits";
import { openTaskCreateSurface } from "../../lib/dock-state";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { commitCommands } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { useCanvas, useNodeFieldOf, useNodeValue } from "../../lib/use-model";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { TasksNode } from "../tasks/TasksNode";
import { tasksCardBody } from "../tasks/tasks-pane-model";
import { useNodeUrgency } from "../../lib/use-node-urgency";
import { markColor } from "../../lib/resource-visuals";
import { RegionUrgency } from "@shared/wire/urgency";
import { KindCard, type SpineStatus } from "../nodes/SpineCard";
import { seatChoicesInReach } from "../tasks/tasks-canvas";
import { installIpcTasksSource, useNodeTasks } from "../../lib/tasks-source";
import { getJuntoApi } from "../../lib/junto-api";
import { titleOf } from "@shared/model/title";
import { taskNodeId } from "@shared/task-model";
import { ArtifactsNode } from "../artifacts/ArtifactsNode";
import { AutomationsPane } from "../automations/AutomationsPane";
import { asNodeId } from "@shared/physics/schema";
import "./work-ledger.css";

/** Same 28px amber tile as terminal / cron / page. */
function AmberDecal({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
      {children}
    </div>
  );
}

const canvasName = (): string => state$.canvasName.peek() || "";



type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRequestRename?: () => void;
  readonly onRenameDone?: () => void;
};

/** Glance header: amber decal + title. Rename only via RTS pencil (no dbl-click). */
function SinkGlanceHead({
  nodeId,
  fallback,
  displayLabel,
  decal,
  trailing,
  renaming = false,
  onRenameDone,
}: {
  readonly nodeId: string;
  readonly fallback: string;
  readonly displayLabel?: string;
  readonly decal: ReactNode;
  readonly trailing?: ReactNode;
} & SinkRenameProps) {
  const label = displayLabel ?? fallback;
  const commitRename = (nextFirst: string) => {
    commitCommands((canvas) => renamed(canvas, nodeId, nextFirst));
  };
  return (
    <div className="factory-glance__header flex items-center gap-2">
      <AmberDecal>{decal}</AmberDecal>
      <div className="min-w-0 flex-1">
        {renaming && onRenameDone ? (
          <FirstLineRenameInput
            initial={label}
            ariaLabel={`Rename ${fallback === "tasks" ? "Tasks board" : fallback}`}
            onCommit={commitRename}
            onDone={onRenameDone}
          />
        ) : (
          <div
            className="truncate font-mono text-title font-semibold leading-snug"
            style={{ color: INK }}
            title={label}
          >
            {label}
          </div>
        )}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </div>
  );
}

// --- Cards -----------------------------------------------------------------

/** The Tasks node on the canvas, a kind seat: its counts on the line and the band, the ring saying a seat waits or the operator owes a stamp. The tasks are in the detail view. */
export function TasksCard({
  nodeId,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly nodeId: string;
} & SinkRenameProps) {
  const canvas = use$(state$.canvasName) || "";
  installIpcTasksSource(getJuntoApi()?.resource?.task);
  const views = useNodeTasks(canvas, taskNodeId(asNodeId(nodeId)));
  const name = useNodeValue(canvas, nodeId, (node) => taskBoardTitle(node?.kind === "task" ? node : undefined, nodeId).name);
  const body = tasksCardBody(views);
  // The region frame leans to a blocked or needs-you card at overview.
  useNodeUrgency(
    nodeId,
    body.status === "blocked" ? RegionUrgency.group.blocked : body.status === "needs-you" ? RegionUrgency.group["needs-you"] : undefined,
  );
  const status: SpineStatus | undefined = body.status;
  return (
    <div data-testid="tasks-card">
      <KindCard
        kind="task"
        name={name}
        status={status}
        done={body.count > 0 && body.ledger.finished === body.count}
        line={body.meta}
        ledger={{ kind: "task", ...body.ledger }}
        {...(renaming && onRenameDone
          ? {
              nameEditor: (
                <FirstLineRenameInput
                  initial={name}
                  ariaLabel="Rename Tasks board"
                  onCommit={(next) => commitCommands((canvas) => renamed(canvas, nodeId, next))}
                  onDone={onRenameDone}
                />
              ),
            }
          : {})}
        trailing={
          // A tasks-off build must not open the enqueue surface: the create API
          // is absent, so a historical tasks card keeps only its read glance.
          TASKS_ENABLED ? (
            <button
              type="button"
              className="nodrag nowheel tasks-enqueue"
              style={{ "--mark": markColor("amber") } as CSSProperties}
              data-testid="tasks-card-enqueue"
              title={`Add a task to ${name}`}
              aria-label={`Add a task to ${name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openTaskCreateSurface(nodeId);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Plus size={11} strokeWidth={2.25} aria-hidden />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

export function ArtifactsCard({ nodeId }: { readonly nodeId: string }) {
  const canvasName = use$(state$.canvasName) || "";
  const name = useNodeValue(canvasName, nodeId, (node) => (node === undefined ? "Artifacts" : titleOf(node)));
  const items = useNodeArtifacts(canvasName, asNodeId(nodeId)).filter((entry) => !entry.artifact.archived);
  return (
    <div data-testid="artifacts-card">
      <KindCard
        kind="artifacts"
        name={name}
        line={items.length === 1 ? "1 artifact" : `${items.length} artifacts`}
        ledger={{ kind: "artifacts", count: items.length }}
      />
    </div>
  );
}

/** An Automations node on the canvas: how many it holds, and the first few by name. */
export function AutomationsCard({
  nodeId,
  renaming,
  onRenameDone,
}: {
  readonly nodeId: string;
  readonly renaming: boolean;
  readonly onRenameDone: () => void;
}) {
  const automations = useAutomations(use$(state$.canvasName) || "", asNodeId(nodeId));
  return (
    <div className="factory-glance factory-glance--automations flex h-full w-full flex-col overflow-hidden" data-testid="automations-card">
      <SinkGlanceHead
        nodeId={nodeId}
        fallback="automations"
        decal={<Workflow size={15} />}
        renaming={renaming}
        onRenameDone={onRenameDone}
        trailing={
          <span className="text-caption tabular-nums" style={{ color: DIM }}>
            {automations.length}
          </span>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {automations.slice(0, 4).map((automation) => (
          <div
            key={automation.automationId}
            className="factory-glance__row truncate text-label"
            style={{ color: automation.enabled ? INK : DIM }}
          >
            {automation.name}
          </div>
        ))}
        {automations.length === 0 ? (
          <div className="factory-glance__empty text-caption" style={{ color: DIM }}>
            none yet
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Detail surfaces -------------------------------------------------------

export function TasksDetail({
  nodeId,
  onClose,
  initialItemId,
  openKey,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
  /** Pre-select this task when opening (jump-to-blocker-cause). */
  readonly initialItemId?: string;
  /** Which open this is: a new one selects `initialItemId` again. */
  readonly openKey?: number;
}) {
  const canvasId = use$(state$.canvasName) || "";
  const canvas = useCanvas(canvasId);
  installIpcTasksSource(getJuntoApi()?.resource?.task);
  const node = taskNodeId(asNodeId(nodeId));
  const nameOf = (id: string): string => {
    const found = canvas.nodes.get(asNodeId(id));
    return found === undefined ? id : titleOf(found);
  };
  return (
    <TasksNode
      canvasName={canvasId}
      node={node}
      {...(initialItemId === undefined ? {} : { initialTaskId: initialItemId })}
      {...(openKey === undefined ? {} : { openKey })}
      seats={seatChoicesInReach(canvas, node, nameOf)}
      nodeName={nameOf}
      seatLabel={(id) => (canvas.nodes.has(asNodeId(id)) ? nameOf(id) : "removed seat")}
      onClose={onClose}
    />
  );
}

export function ArtifactsDetail({
  nodeId,
  initialItemId,
  openKey,
  onClose,
}: {
  readonly nodeId: string;
  /** Open on this artifact (a mention or a chip that names it). */
  readonly initialItemId?: string;
  /** Which open this is: a new one selects `initialItemId` again. */
  readonly openKey?: number;
  readonly onClose: () => void;
}) {
  const canvasName = use$(state$.canvasName) || "";
  return (
    <ArtifactsNode
      canvasName={canvasName}
      nodeId={asNodeId(nodeId)}
      {...(initialItemId === undefined ? {} : { initialArtifactId: initialItemId })}
      {...(openKey === undefined ? {} : { openKey })}
      onClose={onClose}
    />
  );
}

/** The operator's Automations pane. Main sets the stored author from the actor. */
export function AutomationsDetail({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const canvasName = use$(state$.canvasName) || "";
  return <AutomationsPane canvasName={canvasName} nodeId={asNodeId(nodeId)} author={OPERATOR} onClose={onClose} />;
}

const OPERATOR = { kind: "operator" } as const;

export function AgentMessagesPane({ nodeId }: { readonly nodeId: string }) {
  const canvas = use$(state$.canvasName) || "";
  const mail = useWorkMail(canvas, nodeId);
  const items = mail.items.map((item) => item.message);

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">messages</div>
      <div className="flex max-h-48 flex-col gap-1 overflow-auto">
        {items.length === 0 ? (
          <div className="text-body" style={{ color: DIM }}>
            no messages
          </div>
        ) : (
          items.map((msg) => {
            const deliveredAt = msg.metadata?.deliveredAt;
            const delivered =
              typeof deliveredAt === "number" && Number.isFinite(deliveredAt)
                ? new Date(deliveredAt).toLocaleTimeString()
                : null;
            // Own (agent) messages are never nudged back — not "pending".
            const stateLabel =
              msg.role === "agent"
                ? "own"
                : delivered
                  ? `delivered - ${delivered}`
                  : "pending";
            return (
              <div key={msg.messageId} className="text-body leading-snug" style={{ color: INK }}>
                <span className="uppercase tracking-wide text-caption" style={{ color: DIM }}>
                  {msg.role}
                </span>{" "}
                {msg.parts
                  .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
                  .map((p) => p.text)
                  .join(" ") || "(parts)"}
                <span className="ml-1.5 text-caption uppercase tracking-wide" style={{ color: DIM }}>
                  {stateLabel}
                </span>
              </div>
            );
          })
        )}
      </div>
      {mail.error ? <p role="alert">{mail.error}</p> : null}
      {mail.nextBeforePosition !== undefined ? (
        <Button size="xs" variant="subtle" disabled={mail.loading} onClick={() => { void mail.loadMore(); }}>Older mail</Button>
      ) : null}
    </div>
  );
}
