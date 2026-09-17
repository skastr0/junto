/**
 * SeatCollaborationBlock — who this seat could ask for help, and what came
 * back from the seats it already asked.
 *
 * Lives inside the card's hover overlay, below the awareness card, and only
 * mounts while the card is hovered: it reads the whole canvas projection (every
 * seat's mailbox) to rank peers, and a canvas does not need that computed for
 * every card at rest.
 *
 * Two planes, as with awareness: the deterministic half is a fact about the
 * fleet (this peer is connected, idle, and wired to this seat), and the
 * awareness half adds only what is already published for that peer — its
 * activity and the words on its own screen. Asking is an operator action that
 * appends ordinary crew mail; nothing is sent without the click.
 */

import { useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  collaborationThreads,
  collaborationThreadsForSource,
  type SeatCollaborationThread,
} from "@shared/seat-collaboration";
import { agentSeat$ } from "../../lib/agent-seat-state";
import {
  askSeatPeer,
  awaitingPeerNodeIds,
  collaborationDraft,
  collaborationFleet,
  collaborationThreadLine,
  collaborationPeerSuggestions,
  mergeCollaborationThreads,
  openSeatCollaboration,
  seatCollaborationSent$,
  SEAT_COLLABORATION_ASK_PREFIX,
  SEAT_COLLABORATION_HEADING,
  type CollaborationSeatFacts,
  type SeatCollaborationPeer,
} from "../../lib/seat-collaboration";
import type { SeatAwarenessAssessment } from "../../lib/seat-awareness-contract";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { state$ } from "../../lib/state";
import { Button, Chip, Eyebrow } from "../ui";

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}...` : text;

export function SeatCollaborationBlock({
  nodeId,
  className,
}: {
  readonly nodeId: string;
  readonly className?: string | undefined;
}): ReactNode {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const seatByBindingId = use$(
    agentSeat$.byBindingId,
  ) as unknown as Readonly<Record<string, AgentSeatStateEvent | undefined>>;
  const awarenessByBindingId = use$(
    seatAwareness$.byBindingId,
  ) as unknown as Readonly<Record<string, SeatAwarenessAssessment | undefined>>;
  const [pendingNodeId, setPendingNodeId] = useState<string>();
  const [error, setError] = useState<string>();

  const sentThreads = use$(seatCollaborationSent$.byRequestId) as unknown as Readonly<
    Record<string, SeatCollaborationThread>
  >;
  const fleet = collaborationFleet({ doc, seatByBindingId, awarenessByBindingId });
  const source = fleet.find((seat: CollaborationSeatFacts) => seat.nodeId === nodeId);
  if (source === undefined) return null;
  const threads = collaborationThreadsForSource(
    mergeCollaborationThreads(collaborationThreads(doc), sentThreads),
    nodeId,
  );
  const awaiting = awaitingPeerNodeIds(threads, nodeId);
  const peers = collaborationPeerSuggestions({
    source,
    fleet,
    awaitingNodeIds: awaiting,
  });
  if (threads.length === 0 && peers.length === 0) return null;

  const ask = (peer: SeatCollaborationPeer) => {
    setPendingNodeId(peer.nodeId);
    setError(undefined);
    void askSeatPeer(
      collaborationDraft({ canvas: canvasName, source, peer }),
    ).then((result) => {
      setPendingNodeId(undefined);
      // The write rebuilds the graph, and the rebuilt card can miss the
      // pointer that never moved. Re-open on the same slot so the new thread
      // is on screen the moment the request exists.
      openSeatCollaboration(nodeId);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section
      aria-label={SEAT_COLLABORATION_HEADING}
      data-seat-collaboration={source.nodeId}
      className={[
        "w-[320px] overflow-hidden rounded-md border border-stroke bg-raise shadow-lg shadow-black/40",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <Eyebrow tone="faint" size="xs">
          {SEAT_COLLABORATION_HEADING}
        </Eyebrow>
        {threads.map((thread) => (
          <div
            key={thread.requestId}
            className="flex flex-col gap-0.5"
            data-collaboration-thread={thread.status}
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[11px] text-ink">
                {thread.targetLabel}
              </span>
              <Chip tone={thread.status === "answered" ? "green" : "steel"}>
                {thread.status === "answered" ? "answered" : "asked"}
              </Chip>
            </div>
            {thread.reply !== undefined && thread.reply.text !== "" ? (
              <p className="text-[10px] leading-snug text-dim">
                {truncate(thread.reply.text, 180)}
              </p>
            ) : (
              <>
                <p className="text-[10px] leading-snug text-dim">
                  {truncate(thread.question, 140)}
                </p>
                <p className="text-[10px] text-faint">
                  {collaborationThreadLine(thread)}
                </p>
              </>
            )}
          </div>
        ))}
        {peers.map((peer) => (
          <div
            key={peer.nodeId}
            className="flex flex-col gap-1 border-t border-stroke pt-2"
            data-collaboration-peer={peer.basis}
          >
            <p className="text-[11px] leading-snug text-ink">
              {peer.label} can help
            </p>
            <p className="text-[10px] leading-snug text-dim">{peer.why}</p>
            <p className="text-[10px] leading-snug text-faint">
              &ldquo;{truncate(peer.question, 160)}&rdquo;
            </p>
            <Button
              size="xs"
              variant="chrome"
              className="self-start"
              disabled={pendingNodeId === peer.nodeId}
              onClick={() => ask(peer)}
            >
              {SEAT_COLLABORATION_ASK_PREFIX} {peer.label}
            </Button>
          </div>
        ))}
        {error !== undefined ? (
          <p className="text-[10px] leading-snug text-crimson">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
