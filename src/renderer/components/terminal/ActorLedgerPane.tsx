/**
 * Left side-pane ledger for an actor terminal surface — the seat's standing
 * with the work kernel, read from the canvas doc projection (no IPC reads;
 * operator actions go through the work IPC mutations).
 *
 * Sits to the left of the xterm stage inside the same modal plate, mirror of
 * the connections pane on the right. Focus modal only by operator ruling; the
 * pinned dock keeps just the connections pane.
 *
 * Canvas binding: terminal surfaces are node-keyed and survive canvas
 * navigation, but the ledger projects from — and mutates — the ambient
 * canvas. The pane therefore renders only while the ambient canvas is the
 * one the surface was opened from (terminal$.canvasByNodeId).
 */
import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { TaskProposalState, TaskState } from "@shared/work-model";
import type { WorkSeatRecentOpsFeed } from "@shared/work-recent-ops";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  recentOpAtMs,
  recentOpLabel,
  type MailRow,
} from "../../lib/actor-ledger";
import {
  artifactRowsForSeat,
  boardRowsForActor,
  claimedTaskRow,
  proposalRowsForSeat,
  requestRowsForSeat,
  seatIdForActorNode,
  type ProposalRow,
  type RequestRow,
} from "../../lib/actor-ledger-work";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { Button, Chip, Eyebrow, IconButton, type ChipTone } from "../ui";
import { Textarea } from "../ui/Field";

const taskStateTone = (state: TaskState): ChipTone => {
  if (state === "working") return "cyan";
  if (state === "input-required") return "amber";
  if (state === "completed") return "green";
  if (state === "submitted" || state === "archived") return "steel";
  return "crimson";
};

const proposalStateTone = (state: TaskProposalState): ChipTone => {
  if (state === "pending") return "amber";
  if (state === "approved") return "green";
  return "crimson";
};

function MailRowItem({
  row,
  nowMs,
  open,
  onToggle,
}: {
  readonly row: MailRow;
  readonly nowMs: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const age = mailAgeLabel(nowMs, row.sentAtMs);
  const inbound = row.direction === "in";
  const unread = inbound && !row.read;
  return (
    <li
      className={[
        "actor-ledger__mail-item",
        unread ? "actor-ledger__mail-item--unread" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="actor-ledger-mail-row"
      data-message-id={row.messageId}
    >
      <button
        type="button"
        className="actor-ledger__mail-row"
        aria-expanded={open}
        title={`${inbound ? `from ${row.fromLabel}` : "self note"}${age ? ` - ${age} ago` : ""}`}
        onClick={onToggle}
      >
        <span className="actor-ledger__mail-head">
          <span className="actor-ledger__mail-dir" aria-hidden>
            {inbound ? "←" : "—"}
          </span>
          <span className="actor-ledger__mail-from">
            {inbound ? row.fromLabel : "self"}
          </span>
          {inbound && !row.delivered ? (
            <Chip tone="amber" title="Waiting for delivery into the seat">
              queued
            </Chip>
          ) : null}
          {age ? (
            <span className="actor-ledger__mail-age" aria-hidden>
              {age}
            </span>
          ) : null}
        </span>
        <span className="actor-ledger__mail-preview">
          {row.preview || "(no text)"}
        </span>
      </button>
      {open ? (
        <div className="actor-ledger__mail-body">{row.body || "(no text)"}</div>
      ) : null}
    </li>
  );
}

function RequestRowItem({
  row,
  pending,
  open,
  onToggle,
  onResolve,
}: {
  readonly row: RequestRow;
  readonly pending: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onResolve: (
    response: string,
    disposition: "completed" | "rejected",
  ) => void;
}) {
  const [response, setResponse] = useState("");
  const canSend = !pending && response.trim().length > 0;
  return (
    <li
      className="actor-ledger__item"
      data-testid="actor-ledger-request-row"
      data-request-id={row.requestId}
    >
      <button
        type="button"
        className="actor-ledger__item-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="actor-ledger__item-head">
          <Chip tone={row.needsInput ? "amber" : taskStateTone(row.state)}>
            {row.needsInput ? "needs you" : row.state}
          </Chip>
        </span>
        <span className="actor-ledger__item-title">{row.title}</span>
        {!open && !row.needsInput && row.response ? (
          <span className="actor-ledger__item-detail">{row.response}</span>
        ) : null}
      </button>
      {open ? (
        <div className="actor-ledger__respond">
          {/* The full decision contract precedes any action. */}
          {row.details ? (
            <div className="actor-ledger__contract">{row.details}</div>
          ) : null}
          {row.response ? (
            <div className="actor-ledger__contract actor-ledger__contract--response">
              {row.response}
            </div>
          ) : null}
          {row.needsInput ? (
            <>
              <Textarea
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  if (!(event.metaKey || event.ctrlKey)) return;
                  event.preventDefault();
                  if (canSend) onResolve(response.trim(), "completed");
                }}
                placeholder="Decision, information, or authorization…"
                rows={3}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              />
              <div className="actor-ledger__actions">
                <Button
                  size="xs"
                  variant="danger"
                  disabled={!canSend}
                  onClick={() => onResolve(response.trim(), "rejected")}
                >
                  Reject
                </Button>
                <Button
                  size="xs"
                  variant="primary"
                  disabled={!canSend}
                  title="⌘↵ / Ctrl+Enter"
                  onClick={() => onResolve(response.trim(), "completed")}
                >
                  Send response
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ProposalRowItem({
  row,
  pending,
  open,
  onToggle,
  onApprove,
  onReject,
}: {
  readonly row: ProposalRow;
  readonly pending: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <li
      className="actor-ledger__item"
      data-testid="actor-ledger-proposal-row"
      data-proposal-id={row.proposalId}
    >
      <button
        type="button"
        className="actor-ledger__item-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="actor-ledger__item-head">
          <Chip tone={proposalStateTone(row.state)}>{row.state}</Chip>
          {row.hasFinishCriteria ? (
            <Chip tone="steel" title="Has finish criteria">
              criteria
            </Chip>
          ) : null}
          {row.dependsOnCount > 0 ? (
            <Chip
              tone="steel"
              title={`${row.dependsOnCount} prerequisite task${row.dependsOnCount === 1 ? "" : "s"}`}
            >
              deps {row.dependsOnCount}
            </Chip>
          ) : null}
        </span>
        <span className="actor-ledger__item-title">{row.title}</span>
      </button>
      {open ? (
        <div className="actor-ledger__respond">
          {/* The full decision contract precedes any action. */}
          {row.details ? (
            <div className="actor-ledger__contract">{row.details}</div>
          ) : null}
          {row.reason ? (
            <div className="actor-ledger__contract actor-ledger__contract--reason">
              Why: {row.reason}
            </div>
          ) : null}
          {row.state === "pending" ? (
            <div className="actor-ledger__actions">
              <Button size="xs" variant="danger" disabled={pending} onClick={onReject}>
                Reject
              </Button>
              <Button size="xs" variant="primary" disabled={pending} onClick={onApprove}>
                Approve
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Renders only for actor-role nodes. Unlike the connections pane it does not
 * require edges: every actor has a mailbox with the kernel.
 */
export function ActorLedgerPane({
  node,
  visible = true,
}: {
  readonly node: CanvasNode;
  /** Parked keep-alive panes pause projection and timers; drafts survive. */
  readonly visible?: boolean;
}) {
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const canvas = use$(state$.canvasName);
  const boundCanvas = use$(terminal$.canvasByNodeId[node.id]);
  const [expanded, setExpanded] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState("");

  const isActor = useMemo(() => {
    const role = roleOf(
      resolveSpec({
        isGroup: isGroup(node),
        kind: node.ether?.entity?.kind,
      }),
    );
    return role === "actor";
  }, [node]);

  // Node-keyed surfaces survive canvas switches; the ledger must not project
  // another canvas's doc onto this seat or aim mutations at it. Unstamped
  // surfaces (pre-existing sessions) keep the old permissive behavior.
  const canvasMatches = boundCanvas === undefined || boundCanvas === canvas;
  // Parked panes keep projecting (sections stay mounted so typed drafts
  // survive re-show); only the age timer pauses off-screen.
  const live = isActor && canvasMatches;

  // The prop node is the open-time snapshot; work containers live on the doc.
  const liveNode = useMemo(
    () => doc.nodes.find((candidate) => candidate.id === node.id) ?? node,
    [doc, node],
  );
  const seatId = useMemo(
    () => seatIdForActorNode(actorRefs, node.id),
    [actorRefs, node.id],
  );
  const claim = useMemo(
    () => (live ? claimedTaskRow(doc, actorRefs, node.id) : undefined),
    [doc, actorRefs, node.id, live],
  );
  const requests = useMemo(
    () => (live && seatId !== undefined ? requestRowsForSeat(doc, seatId) : []),
    [doc, seatId, live],
  );
  const proposals = useMemo(
    () => (live && seatId !== undefined ? proposalRowsForSeat(doc, seatId) : []),
    [doc, seatId, live],
  );
  const artifacts = useMemo(
    () => (live && seatId !== undefined ? artifactRowsForSeat(doc, seatId) : []),
    [doc, seatId, live],
  );
  const boards = useMemo(
    () => (live ? boardRowsForActor(doc, node.id) : []),
    [doc, node.id, live],
  );
  const boardTopics = useMemo(
    () => boards.flatMap((board) => board.topics),
    [boards],
  );
  const boardUnread = boards.reduce(
    (sum, board) => sum + (board.unread ?? 0),
    0,
  );
  const rows = useMemo(
    () => (live ? mailboxRows(doc, liveNode) : []),
    [doc, liveNode, live],
  );
  const counts = useMemo(() => mailboxCounts(rows), [rows]);
  // Operator attention only: unread mail is the SEAT's backlog, not yours.
  const needsYou =
    (claim?.needsInput ? 1 : 0) +
    requests.filter((row) => row.needsInput).length +
    proposals.filter((row) => row.state === "pending").length;

  // Recent-ops receipt feed: identity-backed CLI activity from the kernel
  // (coverage excludes unattributed ops - see work-recent-ops.ts). IPC read,
  // fetched only while actually on screen; 30s refresh.
  const [opsFeed, setOpsFeed] = useState<WorkSeatRecentOpsFeed | null>(null);
  useEffect(() => {
    if (!visible || !expanded || !isActor || !canvasMatches) return;
    const api = getVellumCommandApi();
    if (!api?.workSeatRecentOps) return;
    let stale = false;
    const pull = (): void => {
      void api
        .workSeatRecentOps(canvas, node.id)
        .then((result) => {
          if (!stale && result.ok) setOpsFeed(result.data);
        })
        .catch(() => {
          /* feed is telemetry; a failed pull renders the last snapshot */
        });
    };
    pull();
    const timer = window.setInterval(pull, 30_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [visible, expanded, isActor, canvasMatches, canvas, node.id]);

  // Ages are display-only; refresh once a minute while actually on screen.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || !expanded || rows.length === 0) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [visible, expanded, rows.length]);

  if (!isActor || !canvasMatches) return null;

  const api = getVellumCommandApi();
  const runWork = async (
    key: string,
    operation: () => Promise<WorkOpResult<unknown>>,
  ): Promise<void> => {
    if (!api) return;
    setPendingKeys((current) => new Set(current).add(key));
    setError("");
    try {
      const result = await runCanvasAuthoringOperation(async () => {
        const outcome = await operation();
        if (outcome.ok) applyWorkCanvasWrite(canvas, outcome.doc, outcome.revision);
        return outcome;
      });
      if (result !== undefined && !result.ok) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const toggleOpen = (key: string): void =>
    setOpenKey((current) => (current === key ? null : key));

  const listId = `actor-ledger-mail-${node.id}`;

  return (
    <aside
      className={[
        "actor-ledger",
        expanded ? "actor-ledger--expanded" : "actor-ledger--collapsed",
      ].join(" ")}
      data-testid="actor-ledger"
      aria-label="Agent ledger"
    >
      <header className="actor-ledger__chrome">
        {expanded ? (
          <>
            <Eyebrow tone="steel" size="xs">
              ledger
            </Eyebrow>
            {needsYou > 0 ? (
              <span
                className="actor-ledger__count"
                title={`${needsYou} waiting on you`}
              >
                {needsYou}
              </span>
            ) : null}
            <IconButton
              size="sm"
              className="actor-ledger__toggle"
              title="Collapse ledger"
              aria-label="Collapse ledger pane"
              aria-expanded
              aria-controls={listId}
              onClick={() => setExpanded(false)}
            >
              <PanelLeftClose size={15} strokeWidth={1.75} />
            </IconButton>
          </>
        ) : (
          <IconButton
            size="sm"
            className="actor-ledger__toggle"
            title={`Expand ledger${needsYou > 0 ? ` (${needsYou} waiting on you)` : ""}`}
            aria-label={
              needsYou > 0
                ? `Expand ledger, ${needsYou} waiting on you`
                : "Expand ledger"
            }
            aria-expanded={false}
            aria-controls={listId}
            onClick={() => setExpanded(true)}
          >
            <PanelLeftOpen size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </header>
      {expanded ? (
        <div className="actor-ledger__scroll">
          {error ? (
            <div className="actor-ledger__error" role="alert">
              {error}
              <button type="button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          ) : null}
          {claim ? (
            <section className="actor-ledger__section" aria-label="Claimed task">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">task</span>
              </header>
              <div
                className="actor-ledger__item-row actor-ledger__item-row--static"
                data-testid="actor-ledger-claim"
                title={`Task ${claim.taskId} on ${claim.sinkNodeId}`}
              >
                <span className="actor-ledger__item-head">
                  <Chip tone={taskStateTone(claim.state)}>
                    {claim.needsInput ? "needs you" : claim.state}
                  </Chip>
                </span>
                <span className="actor-ledger__item-title">{claim.title}</span>
              </div>
            </section>
          ) : null}
          {requests.length > 0 ? (
            <section className="actor-ledger__section" aria-label="Escalations">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">escalations</span>
                <span className="actor-ledger__section-meta">
                  {requests.length}
                </span>
              </header>
              <ul className="actor-ledger__list">
                {requests.map((row) => {
                  const key = `request:${row.sinkNodeId}:${row.requestId}`;
                  return (
                    <RequestRowItem
                      key={key}
                      row={row}
                      pending={pendingKeys.has(key)}
                      open={openKey === key}
                      onToggle={() => toggleOpen(key)}
                      onResolve={(response, disposition) =>
                        void runWork(key, () =>
                          api!.workRequestResolve(
                            canvas,
                            row.sinkNodeId,
                            row.requestId,
                            response,
                            disposition,
                          ),
                        )
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
          {proposals.length > 0 ? (
            <section className="actor-ledger__section" aria-label="Proposals">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">proposals</span>
                <span className="actor-ledger__section-meta">
                  {proposals.length}
                </span>
              </header>
              <ul className="actor-ledger__list">
                {proposals.map((row) => {
                  const key = `proposal:${row.sinkNodeId}:${row.proposalId}`;
                  return (
                    <ProposalRowItem
                      key={key}
                      row={row}
                      pending={pendingKeys.has(key)}
                      open={openKey === key}
                      onToggle={() => toggleOpen(key)}
                      onApprove={() =>
                        void runWork(key, () =>
                          api!.workTaskApproveProposal(
                            canvas,
                            row.sinkNodeId,
                            row.proposalId,
                          ),
                        )
                      }
                      onReject={() =>
                        void runWork(key, () =>
                          api!.workTaskRejectProposal(
                            canvas,
                            row.sinkNodeId,
                            row.proposalId,
                          ),
                        )
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
          {artifacts.length > 0 ? (
            <section className="actor-ledger__section" aria-label="Artifacts">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">artifacts</span>
                <span className="actor-ledger__section-meta">
                  {artifacts.length}
                </span>
              </header>
              <ul className="actor-ledger__list">
                {artifacts.map((row) => {
                  const key = `artifact:${row.sinkNodeId}:${row.artifactId}`;
                  return (
                    <li
                      key={key}
                      className="actor-ledger__item"
                      data-testid="actor-ledger-artifact-row"
                      data-artifact-id={row.artifactId}
                    >
                      <button
                        type="button"
                        className="actor-ledger__item-row"
                        aria-expanded={openKey === key}
                        title={`${row.name} - ${row.partCount} part${row.partCount === 1 ? "" : "s"} on ${row.sinkNodeId}`}
                        onClick={() => toggleOpen(key)}
                      >
                        <span className="actor-ledger__item-title">{row.name}</span>
                        <span className="actor-ledger__item-detail">
                          {row.partCount} part{row.partCount === 1 ? "" : "s"}
                        </span>
                      </button>
                      {openKey === key ? (
                        <div className="actor-ledger__mail-body">
                          {row.textPreview
                            ? row.textPreview.length > 600
                              ? `${row.textPreview.slice(0, 600)}…`
                              : row.textPreview
                            : "No text parts — open the artifact library on the sink to view."}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {boardTopics.length > 0 ? (
            <section className="actor-ledger__section" aria-label="Board">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">board</span>
                <span className="actor-ledger__section-meta">
                  {[
                    `${boardTopics.length}`,
                    boardUnread > 0 ? `${boardUnread} unread` : null,
                  ]
                    .filter(Boolean)
                    .join(" - ")}
                </span>
              </header>
              <ul className="actor-ledger__list">
                {boardTopics.map((topic) => (
                  <li
                    key={`board:${topic.sinkNodeId}:${topic.topicId}`}
                    className="actor-ledger__item"
                    data-testid="actor-ledger-board-row"
                    data-topic-id={topic.topicId}
                  >
                    <div
                      className="actor-ledger__item-row actor-ledger__item-row--static"
                      title={`${topic.title} - ${topic.postCount} post${topic.postCount === 1 ? "" : "s"} on ${topic.sinkNodeId}${topic.authorLabel ? ` - opened by ${topic.authorLabel}` : ""}`}
                    >
                      <span className="actor-ledger__item-head">
                        {!topic.open ? <Chip tone="steel">archived</Chip> : null}
                        <span className="actor-ledger__item-title">
                          {topic.title}
                        </span>
                      </span>
                      <span className="actor-ledger__item-detail">
                        {topic.postCount} post{topic.postCount === 1 ? "" : "s"}
                        {mailAgeLabel(nowMs, topic.lastActivityAtMs)
                          ? ` - ${mailAgeLabel(nowMs, topic.lastActivityAtMs)}`
                          : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="actor-ledger__section" aria-label="Mail">
            <header className="actor-ledger__section-head">
              <span className="actor-ledger__section-title">mail</span>
              <span className="actor-ledger__section-meta">
                {counts.total === 0
                  ? ""
                  : [
                      `${counts.total}`,
                      counts.queued > 0 ? `${counts.queued} queued` : null,
                      counts.unread > 0 ? `${counts.unread} unread` : null,
                    ]
                      .filter(Boolean)
                      .join(" - ")}
              </span>
            </header>
            {rows.length > 0 ? (
              <ul id={listId} className="actor-ledger__mail-list">
                {rows.map((row) => (
                  <MailRowItem
                    key={row.messageId}
                    row={row}
                    nowMs={nowMs}
                    open={openKey === `mail:${row.messageId}`}
                    onToggle={() => toggleOpen(`mail:${row.messageId}`)}
                  />
                ))}
              </ul>
            ) : (
              <p className="actor-ledger__empty">No mail yet</p>
            )}
          </section>
          {opsFeed !== null && opsFeed.operations.length > 0 ? (
            <section
              className="actor-ledger__section"
              aria-label="Recent activity"
              title="Identity-backed CLI activity only - task updates are not attributed"
            >
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">activity</span>
                <span className="actor-ledger__section-meta">
                  {opsFeed.lastOpAt !== null &&
                  mailAgeLabel(nowMs, Date.parse(opsFeed.lastOpAt) || undefined)
                    ? `last op ${mailAgeLabel(nowMs, Date.parse(opsFeed.lastOpAt) || undefined)}`
                    : ""}
                </span>
              </header>
              <ul className="actor-ledger__ops" data-testid="actor-ledger-ops">
                {opsFeed.operations.map((op, index) => {
                  const age = mailAgeLabel(nowMs, recentOpAtMs(op));
                  return (
                    <li
                      key={`${op.appliedAt}:${index}`}
                      className="actor-ledger__op"
                      title={`${op.operation} on ${op.targetNodeId} at ${op.appliedAt}`}
                    >
                      <span className="actor-ledger__op-label">
                        {recentOpLabel(op)}
                      </span>
                      {age ? (
                        <span className="actor-ledger__op-age">{age}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="actor-ledger__rail" aria-hidden>
          <span className="actor-ledger__rail-label">ledger</span>
          {needsYou > 0 ? (
            <span className="actor-ledger__count">{needsYou}</span>
          ) : null}
        </div>
      )}
    </aside>
  );
}
