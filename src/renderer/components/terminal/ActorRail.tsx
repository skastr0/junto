/**
 * The agent modal's right rail: the agents this seat is connected to.
 *
 * Each agent is the canvas's own seat (AgentSeatView), fed from the same live
 * stores as its node, so the rail and the canvas cannot disagree. Expanded,
 * a seat shows its ring, name and line; collapsed, the same seat in its
 * compact form, the ring alone. A press anywhere on a seat moves this modal
 * to that agent. When an agent voices a preamble, the canvas's own bubble
 * (PreambleBubble) appears beside its seat for its normal lifetime.
 *
 * Other connections (boards, pages, terminals) follow as plain rows while the
 * rail is expanded. A seat with no connections renders no rail.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { actorRailExpanded, actorRailPeers, setActorRailExpanded } from "../../lib/actor-rail";
import type { ActorEdgeRow } from "../../lib/actor-edges";
import { openActorMirror } from "../../lib/actor-mirrors";
import { openOperatorModal } from "../../lib/operator-modal";
import { isOverseerSeat } from "../../lib/overseer-set";
import { nodeTitle } from "../../lib/presentation";
import { preambleByNodeId$ } from "../../lib/preamble-state";
import { useSeatOnboarding } from "../../lib/seat-onboarding";
import { seatSaying, seatUrgency, type SeatUrgency } from "../../lib/seat-line";
import { sidebarSections$ } from "../../lib/sidebar-sections";
import { urgencyOrder } from "../../lib/urgency-order";
import { state$ } from "../../lib/state";
import { accentColor, INK } from "../../lib/theme";
import { AgentSeatView, SeatName } from "../nodes/AgentSeat";
import { PreambleBubble } from "../nodes/PreambleBubble";
import { seatUrgencyNow, useSeatGlance } from "../SeatRing";
import { IconButton, ListRow } from "../ui";
import "./actor-rail.css";

/** One connected agent: the canvas seat under a cover button that moves to it. */
function RailSeat({
  peer,
  actorNodeId,
  compact,
  onUrgency,
  seatRef,
}: {
  readonly peer: CanvasNode;
  readonly actorNodeId: string;
  readonly compact: boolean;
  readonly onUrgency: (nodeId: string, urgency: SeatUrgency) => void;
  readonly seatRef: (nodeId: string, element: HTMLLIElement | null) => void;
}) {
  const glance = useSeatGlance(peer);
  const onboarding = useSeatOnboarding(peer);
  const bubbleUp = use$(() => preambleByNodeId$[peer.id].get() !== undefined);
  const name = nodeTitle(peer);
  const signal = glance.signal?.signal;
  const urgency = seatUrgency({ activity: glance.activity, signal: glance.signal?.kind, failure: glance.failure });
  useEffect(() => {
    onUrgency(peer.id, urgency);
  }, [onUrgency, peer.id, urgency]);

  // The seat's own words (seatSaying), for the button's name.
  const saying = seatSaying({ activity: glance.activity, signal, failure: glance.failure, health: glance.health });
  // An AI reading is named as one, as everywhere else: never the agent's own claim.
  const state =
    saying.kind === "signal" ? saying.word : saying.kind === "reading" ? `AI reads ${saying.text}` : saying.text;
  return (
    <li
      ref={(element) => seatRef(peer.id, element)}
      className="actor-rail__seat"
      data-testid="actor-rail-seat"
      data-peer-node-id={peer.id}
    >
      <button
        type="button"
        className="actor-rail__go"
        aria-label={`Go to ${name}${state ? `, ${state}` : ""}`}
        // A showing bubble silences the hover text, which would sit on it.
        aria-expanded={bubbleUp ? true : undefined}
        title={`Go to ${name}`}
        data-testid="actor-rail-go"
        onClick={() => openActorMirror(peer, actorNodeId)}
      />
      <AgentSeatView
        identity={peer.id}
        activity={glance.activity}
        title={<SeatName name={name} color={peer.color ? accentColor(peer.color) : INK} />}
        harness={glance.harness}
        context={glance.failure}
        health={glance.health}
        signal={{ worst: signal, openCount: glance.signal?.openCount ?? 0 }}
        onboarding={onboarding}
        // Signals live in the needs-you feed now.
        onSignalOpen={() => openOperatorModal("feed")}
        overseer={isOverseerSeat(peer)}
        compact={compact}
      />
    </li>
  );
}

/**
 * Where a seat's bubble hangs: just left of the rail, level with the seat's
 * centre, its tail on the card's right edge pointing at the portrait.
 */
function RailBubble({
  nodeId,
  seat,
  scroller,
}: {
  readonly nodeId: string;
  readonly seat: () => HTMLLIElement | undefined;
  readonly scroller: () => HTMLElement | null;
}) {
  const bubble = use$(preambleByNodeId$[nodeId]);
  const [top, setTop] = useState<number | null>(null);
  const shown = bubble !== undefined;
  useLayoutEffect(() => {
    if (!shown) return;
    const list = scroller();
    const place = (): void => {
      const element = seat();
      if (!element || !list) return setTop(null);
      // Both the seat and this anchor measure from the rail (their offset parent).
      const middle = element.offsetTop + element.offsetHeight / 2 - list.scrollTop;
      // A seat scrolled out of the rail shows no bubble.
      const visible = middle > list.offsetTop && middle < list.offsetTop + list.clientHeight;
      setTop(visible ? middle : null);
    };
    place();
    list?.addEventListener("scroll", place, { passive: true });
    return () => list?.removeEventListener("scroll", place);
  }, [shown, seat, scroller]);
  if (!bubble || top === null) return null;
  return (
    <div className="actor-rail__bubble" style={{ top }} data-testid="actor-rail-bubble" data-peer-node-id={nodeId}>
      <PreambleBubble nodeId={nodeId} bubble={bubble} selected={false} tail="right" />
    </div>
  );
}

const boardMeta = (row: ActorEdgeRow): string | undefined =>
  row.boardNotify === "on" ? "wakes" : row.boardNotify === "off" ? "quiet" : undefined;

export function ActorRail({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const expanded = actorRailExpanded(use$(sidebarSections$.open));
  const { agents, others } = useMemo(() => actorRailPeers(doc, node.id), [doc, node.id]);

  // Order: most urgent first, by name inside a group. Seats report their own
  // urgency, so the list reorders only when a seat changes group.
  const [urgencyById, setUrgencyById] = useState<Readonly<Record<string, SeatUrgency>>>({});
  const onUrgency = useCallback((nodeId: string, urgency: SeatUrgency) => {
    setUrgencyById((current) => (current[nodeId] === urgency ? current : { ...current, [nodeId]: urgency }));
  }, []);
  const ordered = useMemo(
    () => urgencyOrder(agents, (peer) => urgencyById[peer.id] ?? seatUrgencyNow(peer)),
    [agents, urgencyById],
  );

  const seats = useRef(new Map<string, HTMLLIElement>());
  const seatRef = useCallback((nodeId: string, element: HTMLLIElement | null) => {
    if (element) seats.current.set(nodeId, element);
    else seats.current.delete(nodeId);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const scroller = useCallback(() => listRef.current, []);

  if (agents.length + others.length === 0) return null;

  return (
    <aside
      className="actor-rail"
      data-testid="actor-rail"
      data-rail={expanded ? "expanded" : "collapsed"}
      aria-label="Connected agents"
    >
      <div className="actor-rail__bar">
        <IconButton
          size="sm"
          title={expanded ? "Collapse to portraits" : "Expand connected agents"}
          aria-label={expanded ? "Collapse connected agents" : "Expand connected agents"}
          aria-expanded={expanded}
          data-testid="actor-rail-toggle"
          onClick={() => setActorRailExpanded(!expanded)}
        >
          {expanded ? <PanelRightClose size={15} strokeWidth={1.75} /> : <PanelRightOpen size={15} strokeWidth={1.75} />}
        </IconButton>
      </div>
      <div ref={listRef} className="actor-rail__list">
        <ul className="actor-rail__seats">
          {ordered.map((peer) => (
            <RailSeat
              key={peer.id}
              peer={peer}
              actorNodeId={node.id}
              compact={!expanded}
              onUrgency={onUrgency}
              seatRef={seatRef}
            />
          ))}
        </ul>
        {expanded && others.length > 0 ? (
          <ul className="actor-rail__others" data-testid="actor-rail-others">
            {others.map((row) => (
              <li key={row.peerId} data-peer-node-id={row.peerId} data-peer-kind={row.peerKind}>
                <ListRow title={row.peerTitle} meta={boardMeta(row) ?? row.peerKind} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="actor-rail__bubbles">
        {ordered.map((peer) => (
          <RailBubble
            key={peer.id}
            nodeId={peer.id}
            seat={() => seats.current.get(peer.id)}
            scroller={scroller}
          />
        ))}
      </div>
    </aside>
  );
}
