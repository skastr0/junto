/**
 * A canvas node in the Spines language (docs/node-card-language.md): one head
 * chip, a status tag when the status is notable, and what the node holds
 * hanging from the chip on a thin spine. A kind hands over data, never
 * markup; the same props draw the far disc (the chip, its glyph and its
 * status pip), so near and far cannot disagree.
 *
 * Paint is spine-card.css, tokens only. Tiers hide by visibility, so the
 * node's size never changes with zoom.
 */
import { useContext, useEffect, type ReactNode } from "react";
import {
  NodeBlockedContext,
  nodeStatusWord,
  NodeIdContext,
  publishNodeSpokenKind,
  publishNodeStatus,
  shownStatus,
  type NodeStatus,
} from "../../lib/node-status";
import { RegionUrgency, SeatUrgency } from "@shared/wire/urgency";
import "./spine-card.css";

/** A glyph hue: a theme token, worn by the mark only, never by a word. */
export type SpineHue = "green" | "violet" | "amber" | "indigo" | "orange" | "cyan" | "steel" | "dim";

/** The statuses a node says. Idle says nothing. */
export type SpineStatus = NodeStatus;

type StatusLook = {
  readonly word: string;
  readonly shape: "triangle" | "dot" | "arc" | "ring";
  readonly tone: "crimson" | "amber" | "cyan" | "faint";
};

/** Every status is a shape and a word, at every tier; never colour alone. */
export const spineStatusLook = (status: SpineStatus): StatusLook => {
  const word = nodeStatusWord(status);
  switch (status) {
    case RegionUrgency.group.blocked:
    case "failed":
      return { word, shape: "triangle", tone: "crimson" };
    case RegionUrgency.group["needs-you"]:
      return { word, shape: "dot", tone: "amber" };
    case SeatUrgency.group.working:
      return { word, shape: "arc", tone: "cyan" };
    default:
      // off, retired
      return { word, shape: "ring", tone: "faint" };
  }
};

/** One row on the spine. `key` is stable across renders (an item id). */
export type SpineRow = {
  readonly key: string;
  /** A 12px mark before the text: a type glyph, a state glyph, an on dot. */
  readonly mark?: ReactNode;
  readonly text: ReactNode;
  /** Dim words after the text: an automation's trigger. */
  readonly detail?: string;
  /** A flagged row: its tick and mark take the tone. */
  readonly tone?: "crimson" | "amber";
};

/** At most this many rows hang from a spine; the rest read as "+N more". */
export const SPINE_ROWS_MAX = 4;

export type SpineCardProps = {
  /** The kind's glyph, drawn 15px at near and held at 14 screen px far. */
  readonly glyph: ReactNode;
  readonly hue: SpineHue;
  readonly name: string;
  /** Tabular count after the name: tasks on the board, live artifacts, automations. */
  readonly count?: number;
  readonly status?: SpineStatus;
  /** The one on-card instrument, at the chip's right end (the task enqueue). */
  readonly trailing?: ReactNode;
  /**
   * What hangs below. A leaf (page, terminal, git, file, link) has one dim
   * line and no spine; a holder has a meta line and rows on the spine.
   */
  readonly body?:
    | { readonly kind: "leaf"; readonly line: string }
    | {
        readonly kind: "spine";
        readonly meta: string;
        readonly rows: ReadonlyArray<SpineRow>;
        /**
         * Rows held but not passed. Pass every row, or pass a few and say how
         * many more: rows past SPINE_ROWS_MAX are added to this, never both.
         */
        readonly more?: number;
      };
  /** Peer and stub: a dashed chip, no fill. */
  readonly dashed?: boolean;
  /** Stands in for the glyph: a peer's portrait disc. */
  readonly portrait?: ReactNode;
  /** What a screen reader calls the node in place of its kind word: "seat on studio". */
  readonly spokenKind?: string;
  /** Stands in for the name while it is being renamed (a FirstLineRenameInput). */
  readonly nameEditor?: ReactNode;
};

export function SpineStatusTag({ status }: { readonly status: SpineStatus }) {
  const look = spineStatusLook(status);
  return (
    <span className="spine-tag" data-tone={look.tone}>
      <span className="spine-shape" data-shape={look.shape} aria-hidden />
      {look.word}
    </span>
  );
}

export function SpineCard({ glyph, hue, name, count, status: reported, trailing, body, dashed = false, portrait, nameEditor, spokenKind }: SpineCardProps) {
  const rows = body?.kind === "spine" ? body.rows.slice(0, SPINE_ROWS_MAX) : [];
  const more = body?.kind === "spine" ? (body.more ?? 0) + Math.max(0, body.rows.length - SPINE_ROWS_MAX) : 0;
  const status = shownStatus(reported, useContext(NodeBlockedContext));
  const look = status === undefined ? undefined : spineStatusLook(status);
  // The node's spoken name says the tag too (Canvas flowNodeLabel).
  const nodeId = useContext(NodeIdContext);
  useEffect(() => {
    if (nodeId === "") return;
    publishNodeStatus(nodeId, status);
  }, [nodeId, status]);
  useEffect(() => {
    if (nodeId === "") return;
    publishNodeSpokenKind(nodeId, spokenKind);
  }, [nodeId, spokenKind]);
  useEffect(
    () => () => {
      if (nodeId === "") return;
      publishNodeStatus(nodeId, undefined);
      publishNodeSpokenKind(nodeId, undefined);
    },
    [nodeId],
  );
  return (
    <div className="spine-card" data-status={status} data-tone={look?.tone}>
      <div className="spine-head">
        <span className="spine-chip" data-dashed={dashed ? "true" : undefined} data-hue={hue}>
          <span className="spine-chip__glyph" aria-hidden>
            {portrait ?? glyph}
          </span>
          {nameEditor ?? (
            <span className="spine-chip__name" title={name}>
              {name}
            </span>
          )}
          {count === undefined ? null : <span className="spine-chip__count">{count}</span>}
          {trailing === undefined ? null : <span className="spine-chip__trailing">{trailing}</span>}
          {look === undefined ? null : <span className="spine-pip spine-shape" data-shape={look.shape} aria-hidden />}
        </span>
        {status === undefined ? null : <SpineStatusTag status={status} />}
      </div>
      {body?.kind === "leaf" ? <p className="spine-leaf">{body.line}</p> : null}
      {body?.kind === "spine" ? (
        <ul className="spine">
          <li className="spine__meta">{body.meta}</li>
          {rows.map((row) => (
            <li key={row.key} className="spine__row" data-tone={row.tone}>
              {row.mark === undefined ? null : (
                <span className="spine__mark" aria-hidden>
                  {row.mark}
                </span>
              )}
              <span className="spine__text">{row.text}</span>
              {row.detail === undefined ? null : <span className="spine__detail">{row.detail}</span>}
            </li>
          ))}
          {more > 0 ? <li className="spine__more">+{more} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
