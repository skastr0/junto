import { useMemo, useState } from "react";
import { ulid } from "ulid";
import type {
  Task,
  Artifact,
  CanvasNode,
  Message,
  Part,
  TaskState,
} from "@shared/canvas";
import { claimedByOf, isTerminalTaskState, taskBrief } from "@shared/task";
import { sinkGlance, workRoleOf } from "@shared/attention";
import type { WorkOpResult } from "@shared/ipc";
import { DetailModal } from "../DetailModal";
import { applyWorkCanvasWrite, runFactoryClaimTick, setNodeWorkRole } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { getVellumApi } from "../../lib/vellum-api";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";

/** Baseline renderer revision + merge freeform after every successful work op. */
const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

/**
 * Keep renderer-originated WorkService writes inside the same admission and
 * drain boundary as direct canvas create/delete operations. A call admitted
 * before signal quiescence may finish on disk, but its returning renderer
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

const isImagePart = (part: Part): boolean => {
  if (part.kind === "url" && part.mediaType?.startsWith("image/")) return true;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) return true;
  if (part.kind === "url" && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(part.url)) return true;
  return false;
};

const imageSrc = (part: Part): string | undefined => {
  if (part.kind === "url" && isImagePart(part)) return part.url;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) {
    return `data:${part.mediaType};base64,${part.bytesBase64}`;
  }
  return undefined;
};

function PartView({ part }: { readonly part: Part }) {
  if (part.kind === "text") {
    return (
      <div className="whitespace-pre-wrap text-[12px] leading-snug" style={{ color: INK }}>
        {part.text}
      </div>
    );
  }
  if (part.kind === "url") {
    const src = imageSrc(part);
    if (src) {
      return (
        <a href={part.url} target="_blank" rel="noreferrer" className="block">
          <img
            src={src}
            alt={part.mediaType ?? "image"}
            className="max-h-48 max-w-full rounded border object-contain"
            style={{ borderColor: withAlpha(HUE.amber, 0.25) }}
          />
        </a>
      );
    }
    return (
      <a
        href={part.url}
        target="_blank"
        rel="noreferrer"
        className="text-[12px] underline"
        style={{ color: HUE.cyan }}
      >
        {part.url}
      </a>
    );
  }
  if (part.kind === "raw") {
    const src = imageSrc(part);
    if (src) {
      return (
        <img
          src={src}
          alt={part.mediaType ?? "image"}
          className="max-h-48 max-w-full rounded border object-contain"
          style={{ borderColor: withAlpha(HUE.amber, 0.25) }}
        />
      );
    }
    const blob = () => {
      try {
        const binary = atob(part.bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const file = new Blob([bytes], { type: part.mediaType ?? "application/octet-stream" });
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = `artifact-${Date.now()}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };
    return (
      <button type="button" className="text-[12px]" style={{ color: HUE.cyan }} onClick={blob}>
        save raw ({part.mediaType ?? "bytes"})
      </button>
    );
  }
  return (
    <pre className="overflow-auto text-[11px]" style={{ color: DIM }}>
      {JSON.stringify(part.data, null, 2)}
    </pre>
  );
}

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
    <div className="flex h-full w-full flex-col overflow-hidden">
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
    <div className="flex h-full w-full flex-col overflow-hidden">
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

function TaskFocusRow({
  task,
  onTransition,
  error,
}: {
  readonly task: Task;
  readonly onTransition: (state: TaskState, note?: string) => void | Promise<void>;
  readonly error?: string;
}) {
  const claim = claimedByOf(task);
  const human =
    task.state === "input-required" || task.state === "auth-required" ? "fire" : "idle";
  const nextHuman =
    task.state === "working" || task.state === "submitted"
      ? (["input-required", "completed", "failed"] as const)
      : task.state === "input-required"
        ? (["working", "completed", "rejected"] as const)
        : ([] as const);
  return (
    <div
      className="rounded border p-3"
      data-attention={human}
      style={{ borderColor: withAlpha(HUE.amber, 0.2), background: withAlpha("#0c0b09", 0.4) }}
    >
      <div className="text-[14px] font-medium" style={{ color: INK }}>
        {taskBrief(task)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: DIM }}>
        <span style={{ color: stateHue(task.state) }}>{task.state}</span>
        {claim ? <span>worker {claim}</span> : <span>unclaimed</span>}
      </div>
      {task.history.length > 1 ? (
        <div className="mt-2 max-h-24 overflow-auto text-[11px]" style={{ color: DIM }}>
          {task.history
            .slice(1)
            .map((msg) =>
              msg.parts
                .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
                .map((p) => p.text)
                .join(" "),
            )
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}
      {nextHuman.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {nextHuman.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded border px-2 py-0.5 text-[10px]"
              style={{ borderColor: withAlpha(stateHue(s), 0.4), color: stateHue(s) }}
              onClick={() => void onTransition(s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="mt-1 text-[10px]" style={{ color: HUE.crimson }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function TasksDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const items = node.ether?.tasks?.items ?? [];
  const glance = sinkGlance(items);
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [roleDraft, setRoleDraft] = useState(workRoleOf(node) ?? "");
  const api = getVellumApi();
  const name = canvasName();

  const create = async () => {
    if (!api || !brief.trim()) return;
    setError("");
    try {
      const result = await runWorkCanvasMutation(
        name,
        () => api.workTaskCreate(name, node.id, brief.trim()),
      );
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
      else setBrief("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runTick = () => {
    setError("");
    try {
      const { claimed } = runFactoryClaimTick();
      if (claimed.length === 0) {
        setError("no free role-matched worker edged to this queue");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <DetailModal onClose={onClose}>
      <div className="flex h-full flex-col gap-3 p-4" data-testid="tasks-focus">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: DIM }}>
            tasks
          </div>
          <div className="text-[16px] font-semibold" style={{ color: INK }}>
            {glance.inFlight} in flight
            {glance.needsInput > 0 ? (
              <span style={{ color: HUE.amber }}> · {glance.needsInput} need input</span>
            ) : null}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-[10px]" style={{ color: DIM }}>
          work role
          <input
            aria-label="Queue work role"
            placeholder="e.g. builder"
            value={roleDraft}
            onChange={(e) => setRoleDraft(e.target.value)}
            onBlur={() => setNodeWorkRole(node.id, roleDraft || undefined)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setNodeWorkRole(node.id, roleDraft || undefined);
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        <div className="flex gap-2">
          <input
            className="flex-1"
            aria-label="New task brief"
            placeholder="what needs doing"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <button type="button" onClick={() => void create()}>
            add
          </button>
          <button type="button" title="Claim submitted tasks with free edged workers" onClick={runTick}>
            tick
          </button>
        </div>
        {error ? (
          <div className="text-[11px]" style={{ color: HUE.crimson }}>
            {error}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {items.map((task) => (
            <TaskFocusRow
              key={task.id}
              task={task}
              error={rowError[task.id]}
              onTransition={async (state) => {
                if (!api) return;
                setRowError((prev) => ({ ...prev, [task.id]: "" }));
                try {
                  const result = await runWorkCanvasMutation(
                    name,
                    () => api.workTaskTransition(name, node.id, task.id, state),
                  );
                  if (result === undefined) return;
                  if (!result.ok) setRowError((prev) => ({ ...prev, [task.id]: result.message }));
                } catch (err) {
                  setRowError((prev) => ({
                    ...prev,
                    [task.id]: err instanceof Error ? err.message : String(err),
                  }));
                }
              }}
            />
          ))}
        </div>
      </div>
    </DetailModal>
  );
}

export function RequestsDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const items = node.ether?.requests?.items ?? [];
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const api = getVellumApi();
  const name = canvasName();

  const create = async () => {
    if (!api || !brief.trim()) return;
    setError("");
    try {
      const result = await runWorkCanvasMutation(
        name,
        () => api.workRequestCreate(name, node.id, brief.trim()),
      );
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
      else setBrief("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <DetailModal onClose={onClose}>
      <div className="flex h-full flex-col gap-3 p-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: DIM }}>
            requests
          </div>
          <div className="text-[16px] font-semibold" style={{ color: INK }}>
            {items.filter((i) => i.state === "input-required").length} pending
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1"
            aria-label="New request brief"
            placeholder="ask…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <button type="button" onClick={() => void create()}>
            request
          </button>
        </div>
        {error ? (
          <div className="text-[11px]" style={{ color: HUE.crimson }}>
            {error}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {items.map((task) => (
            <RequestRow key={task.id} task={task} nodeId={node.id} canvas={name} />
          ))}
        </div>
      </div>
    </DetailModal>
  );
}

function RequestRow({
  task,
  nodeId,
  canvas,
}: {
  readonly task: Task;
  readonly nodeId: string;
  readonly canvas: string;
}) {
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const api = getVellumApi();
  const imageParts = useMemo(
    () =>
      task.history.flatMap((m) => m.parts).filter((p) => isImagePart(p)),
    [task.history],
  );

  const resolve = async (disposition: "completed" | "rejected") => {
    if (!api || !response.trim()) return;
    setError("");
    try {
      const result = await runWorkCanvasMutation(
        canvas,
        () => api.workRequestResolve(
          canvas,
          nodeId,
          task.id,
          response.trim(),
          disposition,
        ),
      );
      if (result === undefined) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setResponse("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: withAlpha(HUE.amber, 0.2), background: withAlpha("#0c0b09", 0.4) }}
    >
      <div className="text-[13px] font-medium" style={{ color: INK }}>
        {taskBrief(task)}
      </div>
      <div className="mt-0.5 text-[10px]" style={{ color: stateHue(task.state) }}>
        {task.state}
        {task.metadata ? ` · ${JSON.stringify(task.metadata)}` : ""}
      </div>
      {imageParts.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {imageParts.map((part, i) => (
            <PartView key={i} part={part} />
          ))}
        </div>
      ) : null}
      {task.state === "input-required" ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea
            aria-label="Request response"
            className="min-h-[56px] w-full text-[12px]"
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder="response…"
          />
          {error ? (
            <div className="text-[10px]" style={{ color: HUE.crimson }}>
              {error}
            </div>
          ) : null}
          <div className="flex gap-2">
            <button type="button" onClick={() => void resolve("completed")}>
              complete
            </button>
            <button type="button" className="inspector-action--danger" onClick={() => void resolve("rejected")}>
              reject
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactsDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const items = node.ether?.artifacts?.items ?? [];
  return (
    <DetailModal onClose={onClose}>
      <div className="flex h-full flex-col gap-3 p-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: DIM }}>
            artifacts
          </div>
          <div className="text-[16px] font-semibold" style={{ color: INK }}>
            {items.length} published
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {items.map((item) => (
            <ArtifactRow key={item.artifactId} artifact={item} />
          ))}
        </div>
      </div>
    </DetailModal>
  );
}

function ArtifactRow({ artifact }: { readonly artifact: Artifact }) {
  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: withAlpha(HUE.amber, 0.2), background: withAlpha("#0c0b09", 0.4) }}
    >
      <div className="text-[13px] font-medium" style={{ color: INK }}>
        {artifact.name?.trim() || artifact.artifactId}
      </div>
      {artifact.taskId ? (
        <div className="text-[10px]" style={{ color: DIM }}>
          taskId · {artifact.taskId}
        </div>
      ) : null}
      <div className="mt-2 flex flex-col gap-1.5">
        {artifact.parts.map((part, i) => (
          <PartView key={i} part={part} />
        ))}
      </div>
    </div>
  );
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
