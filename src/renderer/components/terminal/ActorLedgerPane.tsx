/**
 * Left side-pane ledger for an actor terminal surface — the seat's standing
 * with the work kernel, read from the canvas doc projection (no IPC reads;
 * operator actions go through the work IPC mutations).
 *
 * Sits to the left of the xterm stage inside the same modal plate, mirror of
 * the connections pane on the right. Focus modal only by operator ruling; the
 * pinned dock keeps just the connections pane.
 *
 * Sections: claimed task, escalations (respond/reject inline), proposals
 * (approve/reject inline), mail. Empty sections hide; mail anchors the pane
 * with its own empty state.
 */
import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import type { TaskProposalState, TaskState } from "@shared/work-model";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  type MailRow,
} from "../../lib/actor-ledger";
import {
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
            {inbound ? "←" : "·"}
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
        {!row.needsInput && row.response ? (
          <span className="actor-ledger__item-detail">{row.response}</span>
        ) : null}
      </button>
      {open && row.needsInput ? (
        <div className="actor-ledger__respond">
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
        </div>
      ) : null}
    </li>
  );
}

function ProposalRowItem({
  row,
  pending,
  onApprove,
  onReject,
}: {
  readonly row: ProposalRow;
  readonly pending: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <li
      className="actor-ledger__item"
      data-testid="actor-ledger-proposal-row"
      data-proposal-id={row.proposalId}
    >
      <div className="actor-ledger__item-row">
        <span className="actor-ledger__item-head">
          <Chip tone={proposalStateTone(row.state)}>{row.state}</Chip>
        </span>
        <span className="actor-ledger__item-title" title={row.reason ?? row.title}>
          {row.title}
        </span>
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
    </li>
  );
}

/**
 * Renders only for actor-role nodes. Unlike the connections pane it does not
 * require edges: every actor has a mailbox with the kernel.
 */
export function ActorLedgerPane({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const canvas = use$(state$.canvasName);
  const [expanded, setExpanded] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
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
    () => (isActor ? claimedTaskRow(doc, actorRefs, node.id) : undefined),
    [doc, actorRefs, node.id, isActor],
  );
  const requests = useMemo(
    () => (isActor && seatId !== undefined ? requestRowsForSeat(doc, seatId) : []),
    [doc, seatId, isActor],
  );
  const proposals = useMemo(
    () => (isActor && seatId !== undefined ? proposalRowsForSeat(doc, seatId) : []),
    [doc, seatId, isActor],
  );
  const rows = useMemo(
    () => (isActor ? mailboxRows(doc, liveNode) : []),
    [doc, liveNode, isActor],
  );
  const counts = useMemo(() => mailboxCounts(rows), [rows]);
  const needsYou =
    counts.unread +
    requests.filter((row) => row.needsInput).length +
    proposals.filter((row) => row.state === "pending").length;

  // Ages are display-only; refresh once a minute while visible.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!expanded || rows.length === 0) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [expanded, rows.length]);

  if (!isActor) return null;

  const api = getVellumCommandApi();
  const runWork = async (
    id: string,
    operation: () => Promise<WorkOpResult<unknown>>,
  ): Promise<void> => {
    if (!api) return;
    setPendingId(id);
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
      setPendingId(null);
    }
  };

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
                {requests.map((row) => (
                  <RequestRowItem
                    key={row.requestId}
                    row={row}
                    pending={pendingId === row.requestId}
                    open={openId === row.requestId}
                    onToggle={() =>
                      setOpenId((current) =>
                        current === row.requestId ? null : row.requestId,
                      )
                    }
                    onResolve={(response, disposition) =>
                      void runWork(row.requestId, () =>
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
                ))}
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
                {proposals.map((row) => (
                  <ProposalRowItem
                    key={row.proposalId}
                    row={row}
                    pending={pendingId === row.proposalId}
                    onApprove={() =>
                      void runWork(row.proposalId, () =>
                        api!.workTaskApproveProposal(
                          canvas,
                          row.sinkNodeId,
                          row.proposalId,
                        ),
                      )
                    }
                    onReject={() =>
                      void runWork(row.proposalId, () =>
                        api!.workTaskRejectProposal(
                          canvas,
                          row.sinkNodeId,
                          row.proposalId,
                        ),
                      )
                    }
                  />
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
                    open={openId === row.messageId}
                    onToggle={() =>
                      setOpenId((current) =>
                        current === row.messageId ? null : row.messageId,
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="actor-ledger__empty">No mail yet</p>
            )}
          </section>
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
