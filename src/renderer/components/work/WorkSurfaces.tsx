import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Inbox, ListChecks, MessageSquareText, Package, Plus, X } from "lucide-react";
import type {
  CanvasNode,
  Part,
  TaskState,
} from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { BoardPost, BoardTopic } from "@shared/work-model";
import { isTerminalTaskState, taskBrief } from "@shared/task";
import { sinkGlance } from "@shared/attention";
import { openTaskCreateSurface } from "../../lib/dock-state";
import { DIM, HUE, INK } from "../../lib/theme";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { applyWorkCanvasWrite, editText } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { TaskBoard } from "./TaskBoard";
import { ArtifactLibrary, RequestInbox } from "./WorkLedger";
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

/** First-line rename — Enter/blur commits, Escape discards. */
function SinkRenameInput({
  initial,
  onCommit,
  onDone,
}: {
  readonly initial: string;
  readonly onCommit: (firstLine: string) => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const firedRef = useRef(false);

  const finish = (commit: boolean) => {
    if (firedRef.current) return;
    firedRef.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) onCommit(next);
    onDone();
  };

  return (
    <input
      ref={(el) => {
        el?.focus();
        el?.select();
      }}
      aria-label="Rename sink"
      className="nodrag nopan nowheel w-full truncate bg-transparent text-left font-mono text-[14px] font-semibold leading-snug outline-none"
      style={{ color: INK }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRequestRename?: () => void;
  readonly onRenameDone?: () => void;
};

/** Glance header: amber decal + rename title (terminal weight). */
function SinkGlanceHead({
  node,
  fallback,
  decal,
  trailing,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly fallback: string;
  readonly decal: ReactNode;
  readonly trailing?: ReactNode;
} & SinkRenameProps) {
  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = firstLine || fallback;
  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };
  return (
    <div className="factory-glance__header flex items-center gap-2">
      <AmberDecal>{decal}</AmberDecal>
      <div className="min-w-0 flex-1">
        {renaming && onRenameDone ? (
          <SinkRenameInput initial={label} onCommit={commitRename} onDone={onRenameDone} />
        ) : (
          <button
            type="button"
            className="nodrag nopan w-full truncate text-left font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title={onRequestRename ? "Rename" : undefined}
            onDoubleClick={(event) => {
              if (event.shiftKey || !onRequestRename) return;
              event.preventDefault();
              event.stopPropagation();
              onRequestRename();
            }}
          >
            {label}
          </button>
        )}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </div>
  );
}

const boardTextOf = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");

const boardAuthorLabel = (author: BoardPost["author"] | BoardTopic["openedBy"]): string =>
  author.label ??
  (author.kind === "operator" ? "operator" : (author.nodeId ?? author.kind));

const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

const runWorkCanvasMutation = <T,>(
  canvas: string,
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> =>
  runCanvasAuthoringOperation(async () => acceptWorkResult(canvas, await operation()));

/** One task-state palette, so a task reads the same wherever it is drawn. */
export const stateHue = (state: TaskState): string => {
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
    case "submitted":
      return DIM;
    default:
      return DIM;
  }
};

// --- Cards -----------------------------------------------------------------

/** Glance-grade sink: in-flight count + input-required hot only. */
export function TasksCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const items = node.ether?.tasks?.items ?? [];
  const { inFlight, needsInput } = sinkGlance(items);
  const hotItems = items.filter(
    (t) => t.state === "input-required" || t.state === "auth-required" || t.state === "working",
  );
  return (
    <div className="factory-glance factory-glance--tasks flex h-full w-full flex-col overflow-hidden" data-testid="tasks-card">
      <SinkGlanceHead
        node={node}
        fallback="tasks"
        decal={<ListChecks size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          <>
            <span
              className="text-[9px] tabular-nums"
              style={{ color: needsInput > 0 ? HUE.amber : DIM }}
              data-testid="tasks-glance"
            >
              {inFlight} in flight
              {needsInput > 0 ? ` · ${needsInput} need input` : ""}
            </span>
            <button
              type="button"
              className="nodrag nowheel factory-glance__enqueue"
              data-testid="tasks-card-enqueue"
              title="Enqueue task"
              aria-label="Enqueue task"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openTaskCreateSurface(node, { mode: "task" });
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Plus size={11} strokeWidth={2.25} aria-hidden />
            </button>
          </>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {(hotItems.length > 0 ? hotItems : items.filter((t) => !isTerminalTaskState(t.state)))
          .slice(0, 4)
          .map((item) => (
            <div
              key={item.id}
              className="factory-glance__row factory-glance__row--task truncate text-[10px] leading-snug"
              style={{ color: INK }}
              data-state={item.state}
              data-attention={
                item.state === "input-required" || item.state === "auth-required" ? "fire" : "idle"
              }
            >
              <span style={{ color: stateHue(item.state) }}>●</span> {taskBrief(item)}
            </div>
          ))}
        {items.length === 0 ? (
          <div className="factory-glance__empty text-[9px]" style={{ color: DIM }}>
            empty
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RequestsCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const items = node.ether?.requests?.items ?? [];
  const pending = items.filter((t) => t.state === "input-required").length;
  return (
    <div className="factory-glance factory-glance--requests flex h-full w-full flex-col overflow-hidden" data-testid="requests-card">
      <SinkGlanceHead
        node={node}
        fallback="requests"
        decal={<Inbox size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          <span className="text-[9px] tabular-nums" style={{ color: pending ? HUE.amber : DIM }}>
            {pending} pending
          </span>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div key={item.id} className="factory-glance__row factory-glance__row--request truncate text-[10px] leading-snug" style={{ color: INK }} data-state={item.state}>
            <span style={{ color: stateHue(item.state) }}>●</span> {taskBrief(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BoardCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const topics = node.ether?.board?.topics ?? [];
  const unread = node.ether?.board?.unread ?? 0;
  return (
    <div className="factory-glance factory-glance--board flex h-full w-full flex-col overflow-hidden" data-testid="board-card">
      <SinkGlanceHead
        node={node}
        fallback="board"
        decal={<MessageSquareText size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          <span
            className="text-[9px] tabular-nums"
            style={{ color: unread > 0 ? HUE.amber : DIM }}
            data-testid="board-glance"
          >
            {topics.length} topics
            {unread > 0 ? ` · ${unread} new` : ""}
          </span>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {topics.slice(0, 4).map((topic) => (
          <div key={topic.topicId} className="factory-glance__row factory-glance__row--topic truncate text-[10px] leading-snug" style={{ color: INK }}>
            {topic.title}
          </div>
        ))}
        {topics.length === 0 ? (
          <div className="factory-glance__empty text-[9px]" style={{ color: DIM }}>
            quiet
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ArtifactsCard({
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const items = node.ether?.artifacts?.items ?? [];
  return (
    <div className="factory-glance factory-glance--artifacts flex h-full w-full flex-col overflow-hidden" data-testid="artifacts-card">
      <SinkGlanceHead
        node={node}
        fallback="artifacts"
        decal={<Package size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          <span className="text-[9px] tabular-nums" style={{ color: DIM }}>
            {items.length}
          </span>
        }
      />
      <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {items.slice(0, 4).map((item) => (
          <div key={item.artifactId} className="factory-glance__row factory-glance__row--artifact truncate text-[10px]" style={{ color: INK }}>
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
  initialItemId,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
  /** Pre-select this task when opening (jump-to-blocker-cause). */
  readonly initialItemId?: string;
}) {
  return <TaskBoard node={node} onClose={onClose} initialItemId={initialItemId} />;
}

export function RequestsDetail({
  node,
  onClose,
  initialItemId,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
  /** Pre-select this request when opening (jump-to-blocker-cause). */
  readonly initialItemId?: string;
}) {
  return <RequestInbox node={node} onClose={onClose} initialItemId={initialItemId} />;
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

/** Operator bulletin: full topics + posts from workBoardList (not ether glance). */
export function BoardDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState<string | undefined>();
  const [postText, setPostText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detailTopics, setDetailTopics] = useState<ReadonlyArray<BoardTopic>>(
    [],
  );
  const [loading, setLoading] = useState(false);
  /** Full topics from SQLite list; glance only used as empty-state labels. */
  const topics = detailTopics;
  const selected: BoardTopic | undefined =
    topics.find((t) => t.topicId === selectedTopicId) ?? topics[0];
  const canvas = canvasName();
  const api = getVellumApi();
  const boardTitle =
    node.type === "text" && typeof node.text === "string" && node.text.trim()
      ? node.text.trim()
      : "Bulletin";

  const refreshList = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      // Full board (all topics + posts). Do not pass topicId — that collapses the list.
      const r = await api.workBoardList(canvas, node.id);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setDetailTopics(r.data.topics);
      setSelectedTopicId((prev) => {
        if (prev !== undefined && r.data.topics.some((t) => t.topicId === prev)) {
          return prev;
        }
        return r.data.topics[0]?.topicId;
      });
    } finally {
      setLoading(false);
    }
  }, [api, canvas, node.id]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const run = async <T,>(op: () => Promise<WorkOpResult<T>>) => {
    setError(null);
    if (!api) {
      setError("API unavailable");
      return undefined;
    }
    const result = await runWorkCanvasMutation(canvas, op);
    if (result && !result.ok) setError(result.message);
    return result;
  };

  const posts: ReadonlyArray<BoardPost> = selected?.posts ?? [];

  return (
    <FocusSurface
      label="Bulletin board"
      measure="workspace"
      height="immersive"
      layer="work"
      onClose={onClose}
      data-testid="board-detail"
    >
      <div className="work-ledger-surface flex h-full min-h-0 flex-col">
        <OverlayHeader
          eyebrow="board"
          title={boardTitle}
          status={`${topics.length} topics`}
          actions={
            <>
              <Button
                variant="subtle"
                size="sm"
                onClick={() =>
                  void run(() =>
                    api!.workBoardNotify(canvas, node.id, selected?.topicId),
                  )
                }
              >
                Notify all
              </Button>
              <IconButton aria-label="Close" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </>
          }
        />
        {error ? (
          <div className="work-ledger-error px-3 py-1 text-[11px]">{error}</div>
        ) : null}
        <div className="work-ledger-workspace flex min-h-0 flex-1">
          <div className="work-ledger-list flex w-[40%] flex-col border-r border-stroke/40">
            <div className="flex flex-col gap-1 p-2">
              <Input
                placeholder="New topic title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Textarea
                placeholder="Opening note (optional)"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={2}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!title.trim()}
                onClick={() =>
                  void run(async () => {
                    const r = await api!.workBoardCreateTopic(
                      canvas,
                      node.id,
                      title.trim(),
                      body.trim() || undefined,
                      true,
                    );
                    if (r.ok) {
                      setTitle("");
                      setBody("");
                      setSelectedTopicId(r.data.topic.topicId);
                      await refreshList();
                    }
                    return r;
                  })
                }
              >
                Post topic
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-1">
              {topics.length === 0 ? (
                <div className="p-3 text-[11px]" style={{ color: DIM }}>
                  No topics yet. Post when something needs a shared place.
                </div>
              ) : (
                topics.map((topic) => (
                  <button
                    key={topic.topicId}
                    type="button"
                    className="work-ledger-row w-full text-left"
                    data-selected={selected?.topicId === topic.topicId}
                    onClick={() => setSelectedTopicId(topic.topicId)}
                  >
                    <div className="truncate text-[12px]">{topic.title}</div>
                    <div className="text-[10px]" style={{ color: DIM }}>
                      {topic.postCount} posts · {topic.lastActivityAt}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="work-ledger-detail flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="border-b border-stroke/40 px-3 py-2">
                  <div className="text-[13px] font-medium">{selected.title}</div>
                  <div className="text-[10px]" style={{ color: DIM }}>
                    {boardAuthorLabel(selected.openedBy)} · {selected.postCount}{" "}
                    posts
                    {loading ? " · loading…" : ""}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {selected.parts && selected.parts.length > 0 ? (
                    <div
                      className="mb-3 rounded border border-stroke/30 px-2 py-2 text-[12px] leading-snug"
                      style={{ color: INK }}
                    >
                      <div className="mb-1 text-[10px]" style={{ color: DIM }}>
                        opening · {boardAuthorLabel(selected.openedBy)}
                      </div>
                      {boardTextOf(selected.parts)}
                    </div>
                  ) : null}
                  {posts.length === 0 ? (
                    <div className="text-[11px]" style={{ color: DIM }}>
                      No posts yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {[...posts]
                        .sort((a, b) => a.position - b.position)
                        .map((post) => (
                          <div
                            key={post.postId}
                            className="rounded border border-stroke/25 px-2 py-2"
                            data-testid="board-post"
                          >
                            <div
                              className="mb-1 flex justify-between gap-2 text-[10px]"
                              style={{ color: DIM }}
                            >
                              <span>{boardAuthorLabel(post.author)}</span>
                              <span>{post.createdAt}</span>
                            </div>
                            <div
                              className="whitespace-pre-wrap text-[12px] leading-snug"
                              style={{ color: INK }}
                            >
                              {boardTextOf(post.parts) || "—"}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1 border-t border-stroke/40 p-2">
                  <Textarea
                    placeholder="Optional note…"
                    value={postText}
                    onChange={(e) => setPostText(e.target.value)}
                    rows={2}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() =>
                        void run(() =>
                          api!.workBoardMarkRead(
                            canvas,
                            node.id,
                            selected.topicId,
                          ),
                        )
                      }
                    >
                      Mark read
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!postText.trim()}
                      onClick={() =>
                        void run(async () => {
                          const r = await api!.workBoardPost(
                            canvas,
                            node.id,
                            selected.topicId,
                            postText.trim(),
                          );
                          if (r.ok) {
                            setPostText("");
                            await refreshList();
                          }
                          return r;
                        })
                      }
                    >
                      Post note
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="p-4 text-[11px]" style={{ color: DIM }}>
                Select a topic
              </div>
            )}
          </div>
        </div>
      </div>
    </FocusSurface>
  );
}

export function AgentMessagesPane({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.messages?.items ?? [];

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
    </div>
  );
}
