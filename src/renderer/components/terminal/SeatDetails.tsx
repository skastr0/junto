/**
 * Seat details: everything about one agent seat that is worth a look now and
 * then, kept out of the way behind one button in the agent modal's header.
 * The seat's AI reading and onboarding status, its signals, its standing with
 * the work kernel (task, escalations, raised tasks, artifacts, board) and its
 * mail. Work rows project from the canvas doc (no IPC reads; operator actions
 * go through the work IPC mutations).
 *
 * Canvas binding: terminal surfaces are node-keyed and survive canvas
 * navigation, but these rows project from, and mutate, the ambient canvas.
 * The details therefore render only while the ambient canvas is the one the
 * surface was opened from (terminal$.canvasByNodeId).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { TaskState } from "@shared/work-model";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  visibleMailRows,
  type MailRow,
} from "../../lib/actor-ledger";
import { mailEvidenceLabel } from "../../lib/crew-mail-view";
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
import { terminal$ } from "../../lib/terminal-state";
import { SIGNALS_SECTION, useSeatSignals } from "../../lib/agent-signals-view";
import { clearSectionReveal, sidebarSections$ } from "../../lib/sidebar-sections";
import { getJuntoApi } from "../../lib/junto-api";
import { claimFocus } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { Button, Chip, IconButton, Popover, type ChipTone } from "../ui";
import { DetailsGroup } from "./DetailsGroup";
import { SeatSignalsSection } from "./SeatSignalsSection";
import { OnboardingSection } from "./OnboardingSection";
import { ThreadHealthSection } from "./ThreadHealthSection";
import { Textarea } from "../ui/Field";

// Module-level so the popover's placement effect sees one stable array.
const DETAILS_SIDES = ["below", "left"] as const;

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
        title={`${inbound ? `from ${row.fromLabel}` : "self note"}${age ? `, ${age} ago` : ""}${unread ? ", unread" : ""}`}
        onClick={onToggle}
      >
        <span className="actor-ledger__mail-head">
          <span className="actor-ledger__mail-from">
            {inbound ? row.fromLabel : "self"}
          </span>
          {age ? (
            <span className="actor-ledger__mail-age" aria-hidden>
              {age}
            </span>
          ) : null}
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

/** Renders only for actor-role nodes: every actor has a mailbox with the kernel. */
function SeatDetails({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const canvas = use$(state$.canvasName);
  const boundCanvas = use$(terminal$.canvasByNodeId[node.id]);
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

  const signals = useSeatSignals(canvas, node.id);

  // Ages are display-only; refresh once a minute while open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aged = rows.length + signals.signals.length;
  useEffect(() => {
    if (aged === 0) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [aged]);

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
  const signalsSection = signals.signals.length > 0 ? (
    <SeatSignalsSection
      nodeId={node.id}
      summary={signals}
      nowMs={nowMs}
      respond={signals.respond}
      dismiss={signals.dismiss}
    />
  ) : null;
  return (
    <div className="seat-details" data-testid="seat-details">
      <ThreadHealthSection node={node} />
      <OnboardingSection node={node} />
      {error ? (
        <div className="actor-ledger__error" role="alert">
          {error}
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {signalsSection}
      {claim ? (
        <DetailsGroup
          title="task"
          count={claim.needsInput ? 1 : undefined}
          countTone="amber"
        >
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
        </DetailsGroup>
      ) : null}
      {requests.length > 0 ? (
        <DetailsGroup
          title="escalations"
          count={requests.length}
          countTone={requests.some((row) => row.attention) ? "amber" : "faint"}
        >
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
        </DetailsGroup>
      ) : null}
      {raisedTasks.length > 0 ? (
        <DetailsGroup
          title="raised tasks"
          count={raisedTasks.length}
          countTone={raisedTasks.some((row) => row.awaitingApproval) ? "amber" : "faint"}
        >
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
        </DetailsGroup>
      ) : null}
      {artifacts.length > 0 ? (
        <DetailsGroup
          title="artifacts"
          count={artifacts.length}
        >
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
        </DetailsGroup>
      ) : null}
      {boardTopics.length > 0 ? (
        <DetailsGroup
          title="board"
          count={boardTopics.length}
          meta={boardUnread > 0 ? `${boardUnread} unread` : undefined}
        >
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
        </DetailsGroup>
      ) : null}
      <DetailsGroup
        title="mail"
        count={counts.total}
        meta={counts.unread > 0 ? `${counts.unread} unread` : undefined}
        testId="actor-ledger-mail"
      >
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
      </DetailsGroup>
    </div>
  );
}

/**
 * The one quiet control in the agent modal's header that opens seat details.
 * A signal opened from elsewhere (the canvas seat's badge) opens it too.
 */
export function SeatDetailsButton({ node }: { readonly node: CanvasNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  // Where the keyboard was when the press began (the terminal, usually): a
  // press moves focus to the button, and closing gives it back.
  const cameFrom = useRef<HTMLElement | null>(null);
  const close = (): void => {
    setAnchor(null);
    const back = cameFrom.current;
    cameFrom.current = null;
    if (back?.isConnected) claimFocus(back, "open");
  };
  const reveal = use$(sidebarSections$.reveal);
  useEffect(() => {
    if (!host || reveal?.nodeId !== node.id || reveal.section !== SIGNALS_SECTION) return;
    setAnchor(host);
    clearSectionReveal();
  }, [host, reveal, node.id]);
  return (
    <span ref={setHost} className="inline-flex">
      <IconButton
        size="sm"
        title="Seat details: mail, signals, onboarding"
        aria-label="Seat details"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-testid="seat-details-button"
        onPointerDown={() => {
          const active = document.activeElement;
          if (!anchor) cameFrom.current = active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onClick={(event) => (anchor ? close() : setAnchor(event.currentTarget))}
      >
        <Ellipsis size={15} strokeWidth={1.75} />
      </IconButton>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={close}
          label="Seat details"
          sides={DETAILS_SIDES}
          width={340}
          className="seat-details-popover"
          testId="seat-details-popover"
        >
          <SeatDetails node={node} />
        </Popover>
      ) : null}
    </span>
  );
}
