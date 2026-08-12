/**
 * Left side-pane ledger for an actor terminal surface — the seat's standing
 * with the work kernel, read from the canvas doc projection (no IPC reads).
 *
 * Sits to the left of the xterm stage inside the same modal plate, mirror of
 * the connections pane on the right. Focus modal only by operator ruling; the
 * pinned dock keeps just the connections pane.
 *
 * Sections land in slices: mail (this one), then claimed task / proposals /
 * escalations, then artifacts / board.
 */
import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  mailAgeLabel,
  mailboxCounts,
  mailboxRows,
  type MailRow,
} from "../../lib/actor-ledger";
import { state$ } from "../../lib/state";
import { Chip, Eyebrow, IconButton } from "../ui";

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

/**
 * Renders only for actor-role nodes. Unlike the connections pane it does not
 * require edges: every actor has a mailbox with the kernel.
 */
export function ActorLedgerPane({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const [expanded, setExpanded] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

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
  const rows = useMemo(
    () => (isActor ? mailboxRows(doc, liveNode) : []),
    [doc, liveNode, isActor],
  );
  const counts = useMemo(() => mailboxCounts(rows), [rows]);

  // Ages are display-only; refresh once a minute while visible.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!expanded || rows.length === 0) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [expanded, rows.length]);

  if (!isActor) return null;

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
            {counts.unread > 0 ? (
              <span
                className="actor-ledger__count"
                title={`${counts.unread} unread`}
              >
                {counts.unread}
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
            title={`Expand ledger${counts.unread > 0 ? ` (${counts.unread} unread)` : ""}`}
            aria-label={
              counts.unread > 0
                ? `Expand ledger, ${counts.unread} unread`
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
          {counts.unread > 0 ? (
            <span className="actor-ledger__count">{counts.unread}</span>
          ) : null}
        </div>
      )}
    </aside>
  );
}
