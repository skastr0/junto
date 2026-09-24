/**
 * Compact top section of an actor terminal's right pane — the seat's standing
 * with the work kernel, read from the canvas doc projection (no IPC reads;
 * operator actions go through the work IPC mutations).
 *
 * Sits above connections inside the same right-side instrument pane. Focus
 * modal only by operator ruling; the pinned dock keeps just connections.
 *
 * Canvas binding: terminal surfaces are node-keyed and survive canvas
 * navigation, but the ledger projects from — and mutates — the ambient
 * canvas. The pane therefore renders only while the ambient canvas is the
 * one the surface was opened from (terminal$.canvasByNodeId).
 */
import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { TaskState } from "@shared/work-model";
import type { WorkSeatRecentOpsFeed } from "@shared/work-recent-ops";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  recentOpAtMs,
  recentOpLabel,
  visibleMailRows,
  type MailRow,
} from "../../lib/actor-ledger";
import {
  mailDeliveryLabel,
  mailEvidenceLabel,
  mailKindLabel,
} from "../../lib/crew-mail-view";
import "./actor-ledger-mail.css";
import {
  artifactRowsForSeat,
  boardRowsForActor,
  claimedTaskRow,
  raisedTaskRowsForSeat,
  requestRowsForSeat,
  seatIdForActorNode,
  type RequestRow,
} from "../../lib/actor-ledger-work";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import {
  actorRailsOpen,
  setActorRailOpen,
  terminal$,
} from "../../lib/terminal-state";
import { getJuntoApi } from "../../lib/junto-api";
import { modKeyGlyph } from "../../lib/platform";
import { Button, Chip, Eyebrow, IconButton, type ChipTone } from "../ui";
import { Textarea } from "../ui/Field";

const taskStateTone = (state: TaskState): ChipTone => {
  if (state === "working") return "cyan";
  if (state === "input-required") return "amber";
  if (state === "completed") return "green";
  if (state === "submitted" || state === "archived") return "steel";
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
  const deliveryTone = row.delivery === "waiting" ? "amber" : "steel";
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
      data-delivery={row.delivery}
      data-mail-kind={row.kind}
    >
      <button
        type="button"
        className="actor-ledger__mail-row"
        aria-expanded={open}
        title={`${inbound ? `from ${row.fromLabel}` : "self note"} - ${mailDeliveryLabel(row.delivery)}${age ? ` - ${age} ago` : ""}`}
        onClick={onToggle}
      >
        <span className="actor-ledger__mail-head">
          <span className="actor-ledger__mail-dir" aria-hidden>
            {inbound ? "←" : "—"}
          </span>
          <span className="actor-ledger__mail-from">
            {inbound ? row.fromLabel : "self"}
          </span>
          {age ? (
            <span className="actor-ledger__mail-age" aria-hidden>
              {age}
            </span>
          ) : null}
        </span>
        <span className="actor-ledger__mail-chips">
          <Chip tone={deliveryTone}>{mailDeliveryLabel(row.delivery)}</Chip>
          {row.kind ? <Chip tone="steel">{mailKindLabel(row.kind)}</Chip> : null}
        </span>
        {row.subject ? (
          <span className="actor-ledger__mail-subject">{row.subject}</span>
        ) : null}
        <span className="actor-ledger__mail-preview">
          {row.preview || "(no text)"}
        </span>
      </button>
      {open ? (
        <>
          <div className="actor-ledger__mail-body">{row.body || "(no text)"}</div>
          {row.refs.length > 0 ? (
            <p className="actor-ledger__mail-refs">
              {row.refs.map((ref) => mailEvidenceLabel(ref)).join(", ")}
            </p>
          ) : null}
        </>
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
          <Chip tone={row.attention ? "amber" : taskStateTone(row.state)}>
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
          {row.state === "auth-required" ? (
            <p className="actor-ledger__contract" role="note">
              This request has an older authorization-wait state. It remains
              unresolved and cannot be answered here.
            </p>
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
                aria-label="Your response"
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
                  title={`${modKeyGlyph()}+↵`}
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

function RaisedTaskRowItem({
  row,
  pending,
  open,
  onToggle,
  onApprove,
}: {
  readonly row: import("../../lib/actor-ledger-work").RaisedTaskRow;
  readonly pending: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onApprove: () => void;
}) {
  return (
    <li
      className="actor-ledger__item"
      data-testid="actor-ledger-raised-task-row"
      data-task-id={row.taskId}
    >
      <button
        type="button"
        className="actor-ledger__item-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="actor-ledger__item-head">
          <Chip tone={row.awaitingApproval ? "amber" : taskStateTone(row.state)}>
            {row.awaitingApproval ? "awaiting approval" : row.state}
          </Chip>
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
          {row.awaitingApproval ? (
            <div className="actor-ledger__actions">
              <Button
                size="xs"
                variant="primary"
                disabled={pending}
                onClick={onApprove}
                title="Approve this task so agents can claim it"
              >
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
  // Shared, not pane-local: the focus panel budgets this rail's width so the
  // xterm keeps its columns whichever way the rail sits.
  const railsOpen = use$(terminal$.railsOpenByNodeId);
  const expanded = actorRailsOpen(node.id, railsOpen).ledger;
  const setExpanded = (open: boolean): void =>
    setActorRailOpen(node.id, "ledger", open);
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
  const raisedTasks = useMemo(
    () => (live && seatId !== undefined ? raisedTaskRowsForSeat(doc, seatId) : []),
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
  // Attention = input-required + auth-required (anything waiting on you);
  // answer eligibility stays narrow (needsInput) and is not a count here.
  const needsYou =
    (claim?.needsInput ? 1 : 0) +
    requests.filter((row) => row.attention).length +
    raisedTasks.filter((row) => row.awaitingApproval).length;

  // Recent-ops receipt feed: identity-backed CLI activity from the kernel
  // (coverage excludes unattributed ops - see work-recent-ops.ts). IPC read,
  // fetched only while actually on screen; 30s refresh.
  const [opsFeed, setOpsFeed] = useState<WorkSeatRecentOpsFeed | null>(null);
  useEffect(() => {
    if (!visible || !expanded || !isActor || !canvasMatches) return;
    const api = getJuntoApi();
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

  // Settled mail decays out after the window; unread stays at any age. The
  // minute tick above is what carries a row across the threshold.
  const visibleMail = useMemo(() => visibleMailRows(rows, nowMs), [rows, nowMs]);

  if (!isActor || !canvasMatches) return null;

  const api = getJuntoApi();
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
            <ChevronUp size={15} strokeWidth={1.75} />
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
            <ChevronDown size={15} strokeWidth={1.75} />
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
          {raisedTasks.length > 0 ? (
            <section className="actor-ledger__section" aria-label="Awaiting approval">
              <header className="actor-ledger__section-head">
                <span className="actor-ledger__section-title">raised tasks</span>
                <span className="actor-ledger__section-meta">
                  {raisedTasks.length}
                </span>
              </header>
              <ul className="actor-ledger__list">
                {raisedTasks.map((row) => {
                  const key = `raised:${row.sinkNodeId}:${row.taskId}`;
                  return (
                    <RaisedTaskRowItem
                      key={key}
                      row={row}
                      pending={pendingKeys.has(key)}
                      open={openKey === key}
                      onToggle={() => toggleOpen(key)}
                      onApprove={() => {
                        if (!api?.workTaskPromote) return;
                        void runWork(key, () =>
                          api!.workTaskPromote!(
                            canvas,
                            row.sinkNodeId,
                            row.taskId,
                            undefined,
                          ),
                        );
                      }}
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
                      counts.unread > 0 ? `${counts.unread} unread` : null,
                    ]
                      .filter(Boolean)
                      .join(" - ")}
              </span>
            </header>
            {visibleMail.rows.length > 0 ? (
              <ul id={listId} className="actor-ledger__mail-list">
                {visibleMail.rows.map((row) => (
                  <MailRowItem
                    key={row.messageId}
                    row={row}
                    nowMs={nowMs}
                    open={openKey === `mail:${row.messageId}`}
                    onToggle={() => toggleOpen(`mail:${row.messageId}`)}
                  />
                ))}
              </ul>
            ) : rows.length > 0 ? (
              <p className="actor-ledger__empty">Nothing waiting</p>
            ) : (
              <p className="actor-ledger__empty">No mail yet</p>
            )}
            {visibleMail.hidden > 0 ? (
              <p
                className="actor-ledger__mail-folded"
                data-testid="actor-ledger-mail-folded"
              >
                {`${visibleMail.hidden} settled - junto msg list`}
              </p>
            ) : null}
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
