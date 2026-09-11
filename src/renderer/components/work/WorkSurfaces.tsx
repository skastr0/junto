import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { Bell, Check, Inbox, ListChecks, MessageSquareText, Package, Plus, Send, X } from "lucide-react";
import type {
  CanvasNode,
  Part,
  TaskState,
} from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { BoardPost, BoardTopic } from "@shared/work-model";
import {
  compareTasksByLatestActivityDesc,
  isTerminalTaskState,
  taskBrief,
} from "@shared/task";
import { sinkGlance, taskScanCounts } from "@shared/attention";
import { tasksNodeIdentity } from "@shared/tasks-node-identity";
import { openTaskCreateSurface } from "../../lib/dock-state";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { applyWorkCanvasWrite, editText, renameTasksNode } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { boardAuthorLabel } from "../../lib/board-author";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
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



type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRequestRename?: () => void;
  readonly onRenameDone?: () => void;
};

/** Glance header: amber decal + title. Rename only via RTS pencil (no dbl-click). */
function SinkGlanceHead({
  node,
  fallback,
  displayLabel,
  decal,
  trailing,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly fallback: string;
  readonly displayLabel?: string;
  readonly decal: ReactNode;
  readonly trailing?: ReactNode;
} & SinkRenameProps) {
  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = displayLabel ?? (firstLine || fallback);
  const commitRename = (nextFirst: string) => {
    if (node.ether?.entity?.kind === "task") {
      renameTasksNode(node.id, nextFirst);
      return;
    }
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };
  return (
    <div className="factory-glance__header flex items-center gap-2">
      <AmberDecal>{decal}</AmberDecal>
      <div className="min-w-0 flex-1">
        {renaming && onRenameDone ? (
          <FirstLineRenameInput
            initial={label}
            ariaLabel={`Rename ${node.ether?.entity?.kind === "task" ? "Tasks board" : fallback}`}
            onCommit={commitRename}
            onDone={onRenameDone}
          />
        ) : (
          <div
            className="truncate font-mono text-[14px] font-semibold leading-snug"
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

const boardTextOf = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");

const boardTimestamp = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const boardTopicPreview = (topic: BoardTopic): string => {
  const latestPost = topic.posts?.length
    ? [...topic.posts].sort((a, b) => b.position - a.position)[0]
    : undefined;
  return boardTextOf(latestPost?.parts ?? topic.parts ?? []).trim();
};

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
  node,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const items = node.ether?.tasks?.items ?? [];
  const contract = node.ether?.tasks?.contract;
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
        node={node}
        fallback="tasks"
        displayLabel={tasksNodeIdentity(node).name}
        decal={<ListChecks size={15} />}
        renaming={renaming}
        onRequestRename={onRequestRename}
        onRenameDone={onRenameDone}
        trailing={
          <button
            type="button"
            className="nodrag nowheel factory-glance__enqueue"
            data-testid="tasks-card-enqueue"
            title="Add task"
            aria-label="Add task"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTaskCreateSurface(node);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Plus size={11} strokeWidth={2.25} aria-hidden />
          </button>
        }
      />
      <div
        className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5 pr-1 text-right text-[9px] tabular-nums leading-tight"
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
              className="factory-glance__row factory-glance__row--task truncate text-[10px] leading-snug"
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
  // Newest first (ULID birth order) — matches requests lane SQL + RequestInbox.
  const items = [...(node.ether?.requests?.items ?? [])].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
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
            {unread > 0 ? ` - ${unread} new` : ""}
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
  const items = (node.ether?.artifacts?.items ?? []).filter(
    (item) => item.metadata?.archived !== true,
  );
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
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailTopics, setDetailTopics] = useState<ReadonlyArray<BoardTopic>>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const doc = use$(state$.doc);
  /** Full topics from SQLite list; glance only used as empty-state labels. */
  const topics = detailTopics;
  const selected: BoardTopic | undefined =
    topics.find((t) => t.topicId === selectedTopicId) ?? topics[0];
  const canvas = canvasName();
  const api = getVellumCommandApi();
  // Board node text is a live glance projection ("board" when empty, or recent topic
  // titles), not a stable sink name. Keep the work surface title predictable.
  const boardTitle = "Board";

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
  const unread = node.ether?.board?.unread ?? 0;

  const createTopic = async () => {
    const r = await run(() =>
      api!.workBoardCreateTopic(
        canvas,
        node.id,
        title.trim(),
        body.trim() || undefined,
        true,
      ),
    );
    if (r?.ok) {
      setTitle("");
      setBody("");
      setCreatingTopic(false);
      setSelectedTopicId(r.data.topic.topicId);
      await refreshList();
    }
  };

  const submitPost = async () => {
    if (!selected || !postText.trim()) return;
    const r = await run(() =>
      api!.workBoardPost(canvas, node.id, selected.topicId, postText.trim()),
    );
    if (r?.ok) {
      setPostText("");
      await refreshList();
    }
  };

  return (
    <FocusSurface
      label="Bulletin board"
      measure="workspace"
      height="immersive"
      layer="work"
      onClose={onClose}
      data-testid="board-detail"
    >
      <div className="board-surface flex h-full min-h-0 flex-col">
        <OverlayHeader
          eyebrow="board"
          title={boardTitle}
          status={`${topics.length} ${topics.length === 1 ? "topic" : "topics"}${unread > 0 ? ` - ${unread} new` : ""}`}
          className="board-header"
          actions={
            <>
              <Button
                variant="subtle"
                size="sm"
                className="board-notify"
                onClick={() =>
                  void run(() =>
                    api!.workBoardNotify(canvas, node.id, selected?.topicId),
                  )
                }
              >
                <Bell size={12} aria-hidden />
                Notify all
              </Button>
              <Button
                variant="primary"
                size="sm"
                aria-expanded={creatingTopic}
                onClick={() => setCreatingTopic((open) => !open)}
              >
                <Plus size={12} aria-hidden />
                New topic
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
        <div className="board-workspace">
          <aside className="board-topics" aria-label="Topics">
            <div className="board-topics__heading">
              <span>Topics</span>
              <span>{topics.length}</span>
            </div>
            {creatingTopic ? (
              <form
                className="board-topic-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createTopic();
                }}
              >
                <Input
                  aria-label="Topic title"
                  placeholder="New topic title"
                  value={title}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Textarea
                  aria-label="Opening note"
                  placeholder="Opening note (optional)"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                />
                <div className="board-topic-create__actions">
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => {
                      setCreatingTopic(false);
                      setTitle("");
                      setBody("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" disabled={!title.trim()} type="submit">
                    Create topic
                  </Button>
                </div>
              </form>
            ) : null}
            <div className="board-topic-list">
              {topics.length === 0 ? (
                <div className="board-empty">
                  <MessageSquareText size={20} aria-hidden />
                  <strong>No topics yet</strong>
                  <span>Create a shared place for a decision, update, or question.</span>
                  <Button size="sm" variant="chrome" onClick={() => setCreatingTopic(true)}>
                    <Plus size={12} aria-hidden />
                    New topic
                  </Button>
                </div>
              ) : (
                topics.map((topic) => (
                  <button
                    key={topic.topicId}
                    type="button"
                    className="board-topic-row"
                    aria-current={selected?.topicId === topic.topicId ? "true" : undefined}
                    onClick={() => setSelectedTopicId(topic.topicId)}
                  >
                    <span className="board-topic-row__marker" aria-hidden />
                    <span className="board-topic-row__content">
                      <strong>{topic.title}</strong>
                      {boardTopicPreview(topic) ? <span>{boardTopicPreview(topic)}</span> : null}
                      <small>
                        {boardAuthorLabel(topic.openedBy, doc.nodes)} - {boardTimestamp(topic.lastActivityAt)}
                      </small>
                    </span>
                    <span className="board-topic-row__count" aria-label={`${topic.postCount} posts`}>
                      {topic.postCount}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
          <main className="board-conversation">
            {selected ? (
              <>
                <header className="board-conversation__header">
                  <div>
                    <h2>{selected.title}</h2>
                    <p>
                      Opened by {boardAuthorLabel(selected.openedBy, doc.nodes)} - {boardTimestamp(selected.openedAt)} - {selected.postCount}{" "}
                      {selected.postCount === 1 ? "post" : "posts"}
                      {loading ? " - loading…" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() =>
                      void run(() => api!.workBoardMarkRead(canvas, node.id, selected.topicId))
                    }
                  >
                    <Check size={12} aria-hidden />
                    Mark read
                  </Button>
                </header>
                <div className="board-posts" aria-live="polite">
                  {posts.length === 0 && (!selected.parts || selected.parts.length === 0) ? (
                    <div className="board-posts__empty">No posts yet. Start the conversation below.</div>
                  ) : (
                    (posts.length > 0
                      ? [...posts].sort((a, b) => a.position - b.position)
                      : [
                          {
                            postId: `${selected.topicId}-opening`,
                            topicId: selected.topicId,
                            author: selected.openedBy,
                            parts: selected.parts ?? [],
                            position: 0,
                            createdAt: selected.openedAt,
                          },
                        ]
                    ).map((post, index) => (
                      <article key={post.postId} className="board-post" data-testid="board-post">
                        <div className="board-post__avatar" aria-hidden>
                          {boardAuthorLabel(post.author, doc.nodes).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="board-post__body">
                          <header>
                            <strong>{boardAuthorLabel(post.author, doc.nodes)}</strong>
                            {index === 0 ? <span className="board-post__opening">opened topic</span> : null}
                            <time dateTime={post.createdAt}>{boardTimestamp(post.createdAt)}</time>
                          </header>
                          <p>{boardTextOf(post.parts) || "—"}</p>
                        </div>
                      </article>
                    ))
                  )}
                </div>
                <form
                  className="board-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitPost();
                  }}
                >
                  <Textarea
                    aria-label="Reply"
                    placeholder="Write a reply…"
                    value={postText}
                    onChange={(e) => setPostText(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submitPost();
                      }
                    }}
                    rows={3}
                  />
                  <div className="board-reply__footer">
                    <span>⌘ Enter to post</span>
                    <Button size="sm" variant="primary" disabled={!postText.trim()} type="submit">
                      <Send size={12} aria-hidden />
                      Post reply
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <div className="board-conversation__empty">
                <MessageSquareText size={24} aria-hidden />
                <strong>Select a topic</strong>
                <span>Pick a topic to read it.</span>
              </div>
            )}
          </main>
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
                  ? `delivered - ${delivered}`
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
