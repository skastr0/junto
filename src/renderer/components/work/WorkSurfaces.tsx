import { useTaskItems, useArtifactItems } from "../../lib/use-work-sink";
import { useWorkMail } from "../../lib/use-work-mail";
import { type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ListChecks, Package, Plus } from "lucide-react";
import type { Part, TaskState } from "@shared/work-model";
import { TASKS_ENABLED } from "@shared/features";
import {
  compareTasksByLatestActivityDesc,
  isTerminalTaskState,
  taskBrief,
} from "@shared/task";
import { sinkGlance, taskScanCounts } from "@shared/attention";
import { taskBoardTitle } from "@shared/model/title";
import { renamed } from "../../lib/model-edits";
import { openTaskCreateSurface } from "../../lib/dock-state";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { commitCommands } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { useNodeFieldOf, useNodeValue } from "../../lib/use-model";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { TaskBoard } from "./TaskBoard";
import { ArtifactLibrary } from "./WorkLedger";
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

/** One task-state palette, so a task reads the same wherever it is drawn. */
export const stateHue = (state: TaskState): string => {
  switch (state) {
    case "completed":
      return GREEN;
    case "working":
      return HUE.cyan;
    case "input-required":
    case "auth-required":
      return HUE.amber;
    case "failed":
    case "rejected":
      return HUE.crimson;
    case "canceled":
      return DIM;
    case "submitted":
      return DIM;
    default:
      return DIM;
  }
};

// --- Cards -----------------------------------------------------------------

/** Glance-grade sink: open count + input-required hot only. */
export function TasksCard({
  nodeId,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly nodeId: string;
} & SinkRenameProps) {
  const { items } = useTaskItems(use$(state$.canvasName) || "", nodeId);
  const canvas = use$(state$.canvasName) || "";
  const contract = useNodeFieldOf(canvas, nodeId, "task", (node) => node.contract);
  const name = useNodeValue(canvas, nodeId, (node) => taskBoardTitle(node?.kind === "task" ? node : undefined, nodeId).name);
  const { needsInput } = sinkGlance(items, contract);
  const { completed: completedCount } = taskScanCounts(items, contract);
  // "Open" = unfinished work the fleet can act on: claimable/submitted +
  // working. Input-required and residual auth-required are attention waits,
  // not flight — they render as their own counter, disjoint from open.
  // (Matches the board header counter; sinkGlance.queued would drop
  // approval-gated and operator-assigned submitted tasks.)
  const openCount = items.filter(
    (t) => t.state === "submitted" || t.state === "working",
  ).length;
  const hotItems = items.filter(
    (t) => t.state === "input-required" || t.state === "auth-required" || t.state === "working",
  );
  // Latest activity first on the glance list (and Closed / complete elsewhere).
  const glancePool = (
    hotItems.length > 0 ? hotItems : items.filter((t) => !isTerminalTaskState(t.state))
  )
    .slice()
    .sort(compareTasksByLatestActivityDesc);
  const visibleItems = glancePool.map((item) => ({
    id: item.id,
    brief: taskBrief(item),
    state: item.state,
    kind: "task" as const,
  }));
  const visibleRows = visibleItems.slice(0, 4);
  return (
    <div className="factory-glance factory-glance--tasks flex h-full w-full flex-col overflow-hidden" data-testid="tasks-card">
      <SinkGlanceHead
        nodeId={nodeId}
        fallback="tasks"
        displayLabel={name}
        decal={<ListChecks size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          // A tasks-off build must not open the enqueue surface: the create API
          // is absent, so a historical tasks card keeps only its read glance.
          TASKS_ENABLED ? (
            <button
              type="button"
              className="nodrag nowheel factory-glance__enqueue"
              data-testid="tasks-card-enqueue"
              title="Add task"
              aria-label="Add task"
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
          ) : null
        }
      />
      <div
        className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5 pr-1 text-right text-caption tabular-nums leading-tight"
      >
        <span
          className="max-w-full truncate"
          style={{ color: needsInput > 0 ? HUE.amber : DIM }}
          data-testid="tasks-glance"
        >
          {`${openCount} open${needsInput > 0 ? ` - ${needsInput} need input` : ""}`}
        </span>
        <span
          className="max-w-full truncate"
          style={{ color: completedCount > 0 ? GREEN : DIM }}
          data-testid="tasks-glance-completed"
          aria-label={`${completedCount} completed`}
        >
          {`${completedCount} done`}
        </span>
      </div>
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {visibleRows.map((item) => (
            <div
              key={item.id}
              className="factory-glance__row factory-glance__row--task truncate text-label leading-snug"
              style={{ color: INK }}
              data-state={item.state}
              data-kind={item.kind}
              data-attention={
                item.state === "input-required" || item.state === "auth-required"
                    ? "fire"
                    : "idle"
              }
            >
              <span style={{ color: stateHue(item.state) }}>
                ●
              </span>{" "}
              {item.brief}
            </div>
          ))}
        {items.length === 0 ? (
          <div className="factory-glance__empty text-caption" style={{ color: DIM }}>
            empty
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ArtifactsCard({ nodeId }: { readonly nodeId: string }) {
  const { items: artifactItems } = useArtifactItems(use$(state$.canvasName) || "", nodeId);
  const items = artifactItems.filter(
    (item) => item.metadata?.archived !== true,
  );
  return (
    <div className="factory-glance factory-glance--artifacts flex h-full w-full flex-col overflow-hidden" data-testid="artifacts-card">
      <SinkGlanceHead
        nodeId={nodeId}
        fallback="artifacts"
        // The shelf keeps its kind label; artifact names live in Work.
        displayLabel="artifacts"
        decal={<Package size={15} />}
        trailing={
          <span className="text-caption tabular-nums" style={{ color: DIM }}>
            {items.length}
          </span>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div key={item.artifactId} className="factory-glance__row factory-glance__row--artifact truncate text-label" style={{ color: INK }}>
            {item.name?.trim() || item.artifactId}
          </div>
        ))}
        {items.length === 0 ? (
          <div className="factory-glance__empty text-caption" style={{ color: DIM }}>
            quiet
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
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
  /** Pre-select this task when opening (jump-to-blocker-cause). */
  readonly initialItemId?: string;
}) {
  return <TaskBoard nodeId={nodeId} onClose={onClose} initialItemId={initialItemId} />;
}

export function ArtifactsDetail({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  return <ArtifactLibrary nodeId={nodeId} onClose={onClose} />;
}

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
