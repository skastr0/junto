import type { KeyboardEvent, ReactNode } from "react";
import type { ActivityTone } from "../../lib/activity";
import type { KindLedger } from "../../lib/kind-band";
import { artifactIconKind, taskKindState, type PreviewCardFace } from "../../lib/preview-face";
import { SeatUrgency } from "@shared/wire/urgency";
import { ARTIFACT_TYPE_NOUN, TASK_STATE_VISUAL } from "../../lib/resource-visuals";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { AgentPortrait, PortraitBadge } from "../AgentPortrait";
import { SEAT_PORTRAIT_PX } from "../nodes/AgentSeat";
import { KindSeat, kindRing } from "../nodes/KindSeat";
import "./preview-card.css";

const S = SeatUrgency.group;

/** The box a pad card starts at; the host may resize it, and the card fills whatever it is given. */
export const PREVIEW_CARD_BOX = { width: 288, height: 72 } as const;

export type PreviewCardSize = "block" | "card";

export type PreviewCardProps = PreviewCardFace & {
  /**
   * Opens the thing. In a block only the title opens it (a button, Enter too) and a press anywhere
   * else on the card reaches the host; a card opens on a click anywhere. Absent, nothing opens.
   */
  readonly onOpen?: () => void;
  readonly size?: PreviewCardSize;
};

const NO_ARTIFACTS: KindLedger = { kind: "artifacts", count: 0 };
const ONE_TAB: KindLedger = { kind: "page", tabs: 1 };

const TONE_TEXT: Readonly<Record<ActivityTone, string>> = {
  amber: "text-amber-fg",
  cyan: "text-cyan-fg",
  green: "text-green",
  crimson: "text-crimson-fg",
  steel: "text-dim",
};

const titleOf = (face: PreviewCardFace): string => {
  switch (face.kind) {
    case "task":
      return face.number === undefined ? face.title : `#${face.number} ${face.title}`;
    case "seat":
      return face.name;
    case "artifact":
    case "page":
      return face.title;
    case "missing":
      return face.label;
  }
};

/** One quiet row under the line. */
const Row = ({ children, tone = "text-dim", title }: { readonly children: ReactNode; readonly tone?: string; readonly title?: string }) => (
  <div className="preview-card__row text-label leading-snug">
    <span className={tone} title={title}>
      {children}
    </span>
  </div>
);

/**
 * A Junto thing embedded in an artifact: a task, a seat, an artifact or a page, drawn in the kind
 * seat's language (the seat's ring, the kind icon or the seat's face, the name and its lines).
 * Read-only and pure: the same props draw the same card, and it never takes focus on its own.
 */
export function PreviewCard(props: PreviewCardProps) {
  const { onOpen, size = "block", ...face } = props;
  const title = titleOf(face);
  const opensFromTitle = size === "block" && onOpen !== undefined;
  const opensFromCard = size === "card" && onOpen !== undefined;
  const name = opensFromTitle ? (
    <button type="button" className="preview-card__open" onClick={onOpen} data-testid="preview-card-open" aria-label={`Open ${title}`}>
      <span className="preview-card__name" title={title}>
        {title}
      </span>
    </button>
  ) : (
    <span className="preview-card__name" title={title}>
      {title}
    </span>
  );
  const onKeyDown = opensFromCard
    ? (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onOpen();
      }
    : undefined;
  return (
    <div
      className="preview-card"
      data-testid="preview-card"
      data-size={size}
      data-kind={face.kind}
      data-opens={opensFromCard ? "" : undefined}
      {...(face.kind === "missing" ? { "data-reason": face.reason } : {})}
      {...(opensFromCard ? { role: "button", tabIndex: 0, "aria-label": `Open ${title}`, onClick: onOpen, onKeyDown } : {})}
    >
      <PreviewBody face={face} name={name} />
    </div>
  );
}

function PreviewBody({ face, name }: { readonly face: PreviewCardFace; readonly name: ReactNode }) {
  switch (face.kind) {
    case "task": {
      const visual = TASK_STATE_VISUAL[face.state];
      return (
        <KindSeat kind="task" name={name} line={visual.label} state={taskKindState(face.state)} ledger={face.ledger ? { kind: "task", ...face.ledger } : undefined}>
          {face.assignee ? (
            <div className="preview-card__row text-label leading-snug">
              <AgentPortrait identity={face.assignee.id} size={14} badge={false} />
              <span className="text-dim" title={face.assignee.name}>
                {face.assignee.name}
              </span>
            </div>
          ) : (
            <Row tone="text-faint">unassigned</Row>
          )}
        </KindSeat>
      );
    }
    case "seat": {
      const ring = kindRing(face.state);
      return (
        <div className="junto-seat flex h-full w-full items-center gap-2" data-state={face.state}>
          <ActivityMarkFromSpec
            spec={ring}
            size="seat"
            over={face.harness !== undefined ? <PortraitBadge size={SEAT_PORTRAIT_PX} frame="round" harness={face.harness} /> : undefined}
          >
            <AgentPortrait identity={face.id} size={SEAT_PORTRAIT_PX} frame="round" outline={false} badge={false} />
          </ActivityMarkFromSpec>
          <div className="junto-seat__text min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1">{name}</div>
            <Row tone={TONE_TEXT[ring.tone]}>{ring.label}</Row>
            <Row title={face.line}>{face.line}</Row>
          </div>
        </div>
      );
    }
    case "artifact": {
      const [first, second] = face.lines;
      return (
        <KindSeat
          kind={artifactIconKind(face.type)}
          name={name}
          // One artifact, not a shelf: the band holds nothing to count.
          ledger={NO_ARTIFACTS}
          trailing={<span className="preview-card__version">v{face.version}</span>}
          line={first ?? ARTIFACT_TYPE_NOUN[face.type]}
          lineTitle={first}
        >
          <Row title={second}>{second ?? (first === undefined ? "" : ARTIFACT_TYPE_NOUN[face.type])}</Row>
        </KindSeat>
      );
    }
    case "page":
      return (
        <KindSeat kind="page" name={name} line={kindRing(face.state).label} state={face.state} ledger={ONE_TAB}>
          <Row title={face.url}>{face.url ?? ""}</Row>
        </KindSeat>
      );
    case "missing":
      return (
        <KindSeat
          kind={face.of === "task" ? "task" : face.of === "artifact" ? "artifacts" : face.of === "page" ? "page" : "link"}
          name={name}
          ledger={face.of === "artifact" ? NO_ARTIFACTS : face.of === "page" ? ONE_TAB : undefined}
          line={face.reason === "loading" ? "loading" : "gone, or out of reach"}
          state={face.reason === "loading" ? S.resting : S.offline}
        >
          <Row> </Row>
        </KindSeat>
      );
  }
}
