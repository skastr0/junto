import { useState } from "react";
import { ulid } from "ulid";
import type {
  CanvasNode,
  Message,
  Part,
  TaskState,
} from "@shared/canvas";
import { isTerminalTaskState, taskBrief } from "@shared/task";
import { sinkGlance, workRoleOf } from "@shared/attention";
import type { WorkOpResult } from "@shared/ipc";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { getVellumApi } from "../../lib/vellum-api";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK } from "../../lib/theme";
import { TaskBoard } from "./TaskBoard";
import { ArtifactLibrary, RequestInbox } from "./WorkLedger";

/** Baseline renderer revision + merge freeform after every successful work op. */
const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

/**
 * Keep renderer-originated WorkService writes inside the same admission and
 * drain boundary as direct canvas create/delete operations. A call admitted
 * before signal quiescence may finish its commit, but its returning renderer
 * projection is rejected by applyWorkCanvasWrite after the latch closes.
 */
const runWorkCanvasMutation = <T,>(
  canvas: string,
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> =>
  runCanvasAuthoringOperation(async () => acceptWorkResult(canvas, await operation()));

const stateHue = (state: TaskState): string => {
  switch (state) {
    case "completed":
      return "#5FB98E";
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
    default:
      return HUE.gold;
  }
};

const canvasName = (): string => state$.canvasName.peek() || "";

// --- Cards -----------------------------------------------------------------

/** Glance-grade sink: in-flight count + input-required hot only. */
export function TasksCard({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.tasks?.items ?? [];
  const { inFlight, needsInput } = sinkGlance(items);
  const role = workRoleOf(node);
  const hotItems = items.filter(
    (t) => t.state === "input-required" || t.state === "auth-required" || t.state === "working",
  );
  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="tasks-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
          tasks{role ? ` · ${role}` : ""}
        </span>
        <span
          className="text-[9px] tabular-nums"
          style={{ color: needsInput > 0 ? HUE.amber : DIM }}
          data-testid="tasks-glance"
        >
          {inFlight} in flight
          {needsInput > 0 ? ` · ${needsInput} need input` : ""}
        </span>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {(hotItems.length > 0 ? hotItems : items.filter((t) => !isTerminalTaskState(t.state)))
          .slice(0, 4)
          .map((item) => (
            <div
              key={item.id}
              className="truncate text-[10px] leading-snug"
              style={{ color: INK }}
              data-attention={
                item.state === "input-required" || item.state === "auth-required" ? "fire" : "idle"
              }
            >
              <span style={{ color: stateHue(item.state) }}>●</span> {taskBrief(item)}
            </div>
          ))}
        {items.length === 0 ? (
          <div className="text-[9px]" style={{ color: DIM }}>
            empty
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RequestsCard({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.requests?.items ?? [];
  const pending = items.filter((t) => t.state === "input-required").length;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="requests-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
          requests
        </span>
        <span className="text-[9px] tabular-nums" style={{ color: pending ? HUE.amber : DIM }}>
          {pending} pending
        </span>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div key={item.id} className="truncate text-[10px] leading-snug" style={{ color: INK }}>
            <span style={{ color: stateHue(item.state) }}>●</span> {taskBrief(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArtifactsCard({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.artifacts?.items ?? [];
  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="artifacts-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
          artifacts
        </span>
        <span className="text-[9px] tabular-nums" style={{ color: DIM }}>
          {items.length}
        </span>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div key={item.artifactId} className="truncate text-[10px]" style={{ color: INK }}>
            {item.name?.trim() || item.artifactId}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Detail surfaces -------------------------------------------------------

export function TasksDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  return <TaskBoard node={node} onClose={onClose} />;
}

export function RequestsDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  return <RequestInbox node={node} onClose={onClose} />;
}

export function ArtifactsDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  return <ArtifactLibrary node={node} onClose={onClose} />;
}

export function AgentMessagesPane({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.messages?.items ?? [];
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const api = getVellumApi();
  const name = canvasName();

  const send = async () => {
    if (!api || !text.trim()) return;
    setError("");
    const message: Message = {
      messageId: ulid(),
      role: "user",
      parts: [{ kind: "text", text: text.trim() }],
    };
    try {
      const result = await runWorkCanvasMutation(
        name,
        () => api.workMessageAppend(name, node.id, null, message),
      );
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
      else setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">messages</div>
      <div className="flex max-h-48 flex-col gap-1 overflow-auto">
        {items.length === 0 ? (
          <div className="text-[11px]" style={{ color: DIM }}>
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
                  ? `delivered · ${delivered}`
                  : "pending";
            return (
              <div key={msg.messageId} className="text-[11px] leading-snug" style={{ color: INK }}>
                <span className="uppercase tracking-wide text-[9px]" style={{ color: DIM }}>
                  {msg.role}
                </span>{" "}
                {msg.parts
                  .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
                  .map((p) => p.text)
                  .join(" ") || "(parts)"}
                <span className="ml-1.5 text-[9px] uppercase tracking-wide" style={{ color: DIM }}>
                  {stateLabel}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="mt-2 flex gap-1.5 opacity-80">
        <input
          className="flex-1 text-[11px]"
          aria-label="Append user message"
          placeholder="note (user)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button type="button" className="text-[10px]" onClick={() => void send()}>
          append
        </button>
      </div>
      {error ? (
        <div className="mt-1 text-[10px]" style={{ color: HUE.crimson }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
