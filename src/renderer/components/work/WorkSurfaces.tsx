import { useMemo, useState } from "react";
import { ulid } from "ulid";
import type {
  A2ATask,
  Artifact,
  CanvasNode,
  Message,
  Part,
  TaskState,
} from "@shared/canvas";
import { claimedByOf, countByTaskState, taskBrief } from "@shared/a2a";
import { DetailModal } from "../DetailModal";
import { getVellumApi } from "../../lib/vellum-api";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";

const TASK_STATES: ReadonlyArray<TaskState> = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
];

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

function StateChip({ state, count }: { readonly state: TaskState; readonly count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="rounded px-1 py-0.5 text-[8px] uppercase tracking-wide tabular-nums"
      style={{
        color: stateHue(state),
        background: withAlpha(stateHue(state), 0.12),
        border: `1px solid ${withAlpha(stateHue(state), 0.3)}`,
      }}
    >
      {state} {count}
    </span>
  );
}

// --- Cards -----------------------------------------------------------------

export function TasksCard({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.tasks?.items ?? [];
  const counts = countByTaskState(items);
  const open = items.filter((t) => t.state !== "completed").length;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>
          tasks
        </span>
        <span className="text-[9px] tabular-nums" style={{ color: DIM }}>
          {items.length - open}/{items.length}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-0.5">
        {TASK_STATES.map((s) => (
          <StateChip key={s} state={s} count={counts[s]} />
        ))}
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div
            key={item.id}
            className="truncate text-[10px] leading-snug"
            style={{ color: item.state === "completed" ? DIM : INK }}
          >
            <span style={{ color: stateHue(item.state) }}>●</span>{" "}
            <span style={{ textDecoration: item.state === "completed" ? "line-through" : "none" }}>
              {taskBrief(item)}
            </span>
          </div>
        ))}
        {items.length > 4 ? (
          <div className="text-[9px]" style={{ color: DIM }}>
            +{items.length - 4} more
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

function TaskRow({
  task,
  onTransition,
  onClaim,
}: {
  readonly task: A2ATask;
  readonly onTransition: (state: TaskState, note?: string) => void;
  readonly onClaim: () => void;
}) {
  const claim = claimedByOf(task);
  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: withAlpha(HUE.amber, 0.2), background: withAlpha("#0c0b09", 0.4) }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: INK }}>
            {taskBrief(task)}
          </div>
          <div className="mt-0.5 text-[10px] tabular-nums" style={{ color: DIM }}>
            <span style={{ color: stateHue(task.state) }}>{task.state}</span>
            {claim ? ` · claimedBy ${claim}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className="text-[10px]" onClick={onClaim}>
            claim
          </button>
          <select
            aria-label="Task state"
            className="text-[10px]"
            value={task.state}
            onChange={(e) => onTransition(e.target.value as TaskState)}
          >
            {TASK_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      {task.history.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1 border-t pt-2" style={{ borderColor: withAlpha(DIM, 0.2) }}>
          {task.history.map((msg) => (
            <div key={msg.messageId} className="text-[11px]" style={{ color: msg.role === "agent" ? DIM : INK }}>
              <span className="uppercase tracking-wide text-[9px]" style={{ color: DIM }}>
                {msg.role}
              </span>{" "}
              {msg.parts
                .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
                .map((p) => p.text)
                .join(" ")}
            </div>
          ))}
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
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const api = getVellumApi();
  const name = canvasName();

  const create = async () => {
    if (!api || !brief.trim()) return;
    setError("");
    const result = await api.workTaskCreate(name, node.id, brief.trim());
    if (!result.ok) setError(result.message);
    else setBrief("");
  };

  return (
    <DetailModal onClose={onClose}>
      <div className="flex h-full flex-col gap-3 p-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: DIM }}>
            tasks
          </div>
          <div className="text-[16px] font-semibold" style={{ color: INK }}>
            {items.length} items
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1"
            aria-label="New task brief"
            placeholder="brief…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <button type="button" onClick={() => void create()}>
            create
          </button>
        </div>
        {error ? (
          <div className="text-[11px]" style={{ color: HUE.crimson }}>
            {error}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onClaim={() => {
                void api?.workTaskClaim(name, node.id, task.id, "operator");
              }}
              onTransition={(state) => {
                void api?.workTaskTransition(name, node.id, task.id, state);
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
    const result = await api.workRequestCreate(name, node.id, brief.trim());
    if (!result.ok) setError(result.message);
    else setBrief("");
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
  readonly task: A2ATask;
  readonly nodeId: string;
  readonly canvas: string;
}) {
  const [response, setResponse] = useState("");
  const api = getVellumApi();
  const imageParts = useMemo(
    () =>
      task.history.flatMap((m) => m.parts).filter((p) => isImagePart(p)),
    [task.history],
  );

  const resolve = async (disposition: "completed" | "rejected") => {
    if (!api || !response.trim()) return;
    await api.workRequestResolve(canvas, nodeId, task.id, response.trim(), disposition);
    setResponse("");
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
    const result = await api.workMessageAppend(name, node.id, null, message);
    if (!result.ok) setError(result.message);
    else setText("");
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
          items.map((msg) => (
            <div key={msg.messageId} className="text-[11px] leading-snug" style={{ color: INK }}>
              <span className="uppercase tracking-wide text-[9px]" style={{ color: DIM }}>
                {msg.role}
              </span>{" "}
              {msg.parts
                .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
                .map((p) => p.text)
                .join(" ") || "(parts)"}
            </div>
          ))
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
