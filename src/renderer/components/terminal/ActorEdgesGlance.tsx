/**
 * Right side-pane edge inventory for an actor terminal surface.
 *
 * Sits to the right of the xterm stage inside the same modal plate (not a
 * horizontal strip under the header, not a floating FocusSurface aside).
 * Collapse / expand; still present when pinned.
 *
 * Connected ACTORS render as mirrors: live seat status in the same glyph
 * language as canvas cards, and activation swaps this modal to that actor in
 * place (the dock keeps the previous surface parked and alive). Cmd+] and
 * Cmd+[ cycle the same ring. Other node kinds stay read-only chips.
 *
 * No "soft" / "tasks" edge nature — those were authorial relationship modes.
 * Live stoppage is a derived chip only when the kernel reports blocks.
 */
import { useMemo, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  actorEdgePhaseLabel,
  actorEdgeRows,
  type ActorEdgeRow,
} from "../../lib/actor-edges";
import { mailboxRows, unreadMailByPeer } from "../../lib/actor-ledger";
import { isMirrorablePeer, openActorMirror } from "../../lib/actor-mirrors";
import { agentSeat$, bindingIdForNode } from "../../lib/agent-seat-state";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import {
  cardMark,
  liveAttentionReasons,
  seatFactsForNode,
} from "../../lib/seat-projections";
import { chatCoarse$ } from "../../lib/chat-state";
import {
  actorRailsOpen,
  setActorRailOpen,
  terminal$,
} from "../../lib/terminal-state";
import { useSeatSignalRollup } from "../../lib/agent-signals-state";
import { useThreadHealthMark } from "../../lib/thread-health";
import { ActivityMark, ActivityMarkFromSpec } from "../ActivityMark";
import { AgentPortrait } from "../AgentPortrait";
import { Chip, Eyebrow, IconButton, SidebarSection } from "../ui";

const DirectionMark = ({ direction }: { readonly direction: "out" | "in" }) => (
  <span
    className="actor-edges-glance__dir"
    aria-hidden
    title={direction === "out" ? "Outgoing" : "Incoming"}
  >
    {direction === "out" ? "→" : "←"}
  </span>
);

function EdgeCardBody({
  row,
  seatMark,
  portrait,
}: {
  readonly row: ActorEdgeRow;
  readonly seatMark?: ReactNode;
  /** Agent peers carry their generated portrait beside the name. */
  readonly portrait?: ReactNode;
}) {
  const phase = actorEdgePhaseLabel(row);
  return (
    <>
      <div className="actor-edges-glance__row-head">
        <DirectionMark direction={row.direction} />
        <span className="actor-edges-glance__kind">{row.peerKind}</span>
        {phase ? (
          <Chip tone="crimson" title="Waiting on you">
            {phase}
          </Chip>
        ) : null}
        {seatMark}
      </div>
      {portrait ? (
        <span className="flex min-w-0 items-center gap-2">
          {portrait}
          <span className="actor-edges-glance__title min-w-0">{row.peerTitle}</span>
        </span>
      ) : (
        <span className="actor-edges-glance__title">{row.peerTitle}</span>
      )}
      {(row.boardNotify === "on" || row.boardNotify === "off") && (
        <div className="actor-edges-glance__flags">
          {row.boardNotify === "on" ? (
            <Chip tone="amber" title="Board wake on">
              wakes
            </Chip>
          ) : null}
          {row.boardNotify === "off" ? (
            <Chip tone="steel" title="Board wake off">
              quiet
            </Chip>
          ) : null}
        </div>
      )}
    </>
  );
}

function EdgeCard({
  row,
  peer,
  actorNodeId,
  zone,
  unreadFromPeer,
}: {
  readonly row: ActorEdgeRow;
  readonly peer: CanvasNode | undefined;
  readonly actorNodeId: string;
  readonly zone: "focus" | "pinned";
  /** Inbound mail from this peer the seat has not read yet. */
  readonly unreadFromPeer: number;
}) {
  const mirror = isMirrorablePeer(peer);
  const bindingId = mirror ? bindingIdForNode(peer) : undefined;
  const seatEvent = use$(() =>
    bindingId ? agentSeat$.byBindingId[bindingId].get() : undefined,
  );
  const needsLook = use$(() =>
    bindingId ? agentSeat$.needsLookByBindingId[bindingId].get() === true : false,
  );
  const execution = use$(kernel$.execution);
  const chatByAgent = use$(chatCoarse$) as
    | Record<string, { readonly pendingPermissionId?: string } | undefined>
    | undefined;
  const phase = actorEdgePhaseLabel(row);
  const harness = peer?.ether?.terminal?.harness;
  const canvasName = use$(state$.canvasName);
  const rollup = useSeatSignalRollup(canvasName, peer?.id ?? "");
  const health = useThreadHealthMark(bindingId, rollup?.kind);
  const agentPeer = peer?.ether?.entity?.kind === "agent";
  const portrait =
    agentPeer ? (
      <AgentPortrait
        identity={peer.id}
        harness={typeof harness === "string" && isHarnessId(harness) ? harness : undefined}
        size={24}
      />
    ) : undefined;
  const title = [
    `${row.direction === "out" ? "to" : "from"} ${row.peerTitle}`,
    phase === "blocks" ? "waiting on you" : null,
    row.boardNotify === "on" ? "wakes" : null,
    row.boardNotify === "off" ? "wakes off" : null,
  ]
    .filter(Boolean)
    .join(" - ");

  if (!mirror) {
    return (
      <li
        className="actor-edges-glance__row"
        data-edge-id={row.edgeId}
        data-peer-kind={row.peerKind}
        data-live-phase={row.livePhase ?? undefined}
        title={title}
      >
        <EdgeCardBody row={row} portrait={portrait} />
      </li>
    );
  }

  // Live mirror: same assembled facts as the peer's canvas card. Quiet steel
  // still hides — only live signal (working, attention, blocked, done) marks.
  const seatActivity = peer
    ? cardMark(
        seatFactsForNode({
          nodeId: peer.id,
          seatEvent,
          needsLook,
          attentionReasons: liveAttentionReasons(peer, chatByAgent),
          graphBlocked: execution?.blocked.includes(peer.id) === true,
          managedSeat:
            typeof harness === "string" && isHarnessId(harness),
        }),
      )
    : null;
  const activity =
    seatActivity !== null && seatActivity.tone !== "steel" ? seatActivity : null;
  // An agent peer is shown as its seat: the portrait held by its ring, which
  // carries state, health and signal, so no separate mark beside it.
  const ringed =
    agentPeer && peer && seatActivity ? (
      <ActivityMarkFromSpec
        spec={seatActivity}
        size="glance"
        health={health.health}
        healthValue={health.value}
        healthStale={health.healthStale}
        healthLabel={health.label}
        signal={rollup?.kind}
        signalCount={rollup?.openCount}
        className="actor-edges-glance__seat-mark"
      >
        <AgentPortrait
          identity={peer.id}
          size={20}
          frame="round"
          outline={false}
          badge={false}
        />
      </ActivityMarkFromSpec>
    ) : undefined;

  return (
    <li
      className="actor-edges-glance__item"
      data-edge-id={row.edgeId}
      data-peer-kind={row.peerKind}
      data-live-phase={row.livePhase ?? undefined}
    >
      <button
        type="button"
        className="actor-edges-glance__row actor-edges-glance__row--mirror"
        data-peer-node-id={row.peerId}
        data-seat-state={seatEvent?.state}
        title={`${title} - open here (swaps this view)`}
        aria-label={`Open ${row.peerTitle} here`}
        onClick={() => {
          if (peer) openActorMirror(peer, actorNodeId, zone);
        }}
      >
        <EdgeCardBody
          row={row}
          portrait={ringed ?? portrait}
          seatMark={
            <>
              {unreadFromPeer > 0 ? (
                <span
                  className="actor-edges-glance__mail-count"
                  title={`${unreadFromPeer} unread message${unreadFromPeer === 1 ? "" : "s"} from ${row.peerTitle}`}
                >
                  {unreadFromPeer}
                </span>
              ) : null}
              {activity && !ringed ? (
                <ActivityMark
                  mode={activity.mode}
                  tone={activity.tone}
                  label={activity.label}
                  size="inline"
                  className="actor-edges-glance__seat-mark"
                />
              ) : null}
            </>
          }
        />
      </button>
    </li>
  );
}

/** Incident edges of an actor node as mirror-ready rows, plus unread mail per peer. */
function useActorConnections(node: CanvasNode) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);

  const isActor = useMemo(() => {
    const role = roleOf(
      resolveSpec({
        isGroup: isGroup(node),
        kind: node.ether?.entity?.kind,
      }),
    );
    return role === "actor";
  }, [node]);

  const rows = useMemo(() => {
    if (!isActor) return [];
    const phaseMap = new Map<string, "blocks" | "relates">();
    if (execution?.phaseByEdgeId) {
      for (const [id, phase] of Object.entries(execution.phaseByEdgeId)) {
        if (phase === "blocks" || phase === "relates") phaseMap.set(id, phase);
      }
    }
    return actorEdgeRows(doc, node.id, phaseMap.size > 0 ? phaseMap : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, node.id, isActor, execution, executionRev]);

  const peersById = useMemo(
    () => new Map(doc.nodes.map((n) => [n.id, n] as const)),
    [doc],
  );

  // Mail is edge-shaped: unread-from-peer badges answer "who is waiting on
  // this seat" right on the navigation chips.
  const unreadByPeer = useMemo(() => {
    if (!isActor) return new Map<string, number>();
    const live = doc.nodes.find((n) => n.id === node.id);
    return unreadMailByPeer(live ? mailboxRows(doc, live) : []);
  }, [doc, node.id, isActor]);

  return { isActor, rows, peersById, unreadByPeer };
}

function ConnectionsList({
  node,
  zone,
  listId,
  connections,
}: {
  readonly node: CanvasNode;
  readonly zone: "focus" | "pinned";
  readonly listId: string;
  readonly connections: ReturnType<typeof useActorConnections>;
}) {
  const { rows, peersById, unreadByPeer } = connections;
  const hasMirrors = rows.some((row) => isMirrorablePeer(peersById.get(row.peerId)));
  return (
    <>
      <ul id={listId} className="actor-edges-glance__list">
        {rows.map((row) => (
          <EdgeCard
            key={row.edgeId}
            row={row}
            peer={peersById.get(row.peerId)}
            actorNodeId={node.id}
            zone={zone}
            unreadFromPeer={unreadByPeer.get(row.peerId) ?? 0}
          />
        ))}
      </ul>
      {hasMirrors ? (
        <footer
          className="actor-edges-glance__cycle-hint"
          title="Cmd+] next agent, Cmd+[ previous agent"
        >
          ⌘] ⌘[ cycle actors
        </footer>
      ) : null}
    </>
  );
}

/** Connections as one section of the focus sidebar. */
export function ActorConnectionsSection({ node }: { readonly node: CanvasNode }) {
  const connections = useActorConnections(node);
  if (!connections.isActor || connections.rows.length === 0) return null;
  return (
    <SidebarSection
      storageKey="seat-sidebar:connections"
      title="connections"
      count={connections.rows.length}
      testId="actor-edges-glance"
    >
      <ConnectionsList
        node={node}
        zone="focus"
        listId={`actor-connections-list-${node.id}`}
        connections={connections}
      />
    </SidebarSection>
  );
}

/**
 * Pinned-dock rail: renders only for actor-role nodes with at least one
 * incident edge. Edge editing stays in the inspector / RTS kind surface;
 * mirrors only navigate between already-authored actors.
 */
export function ActorEdgesGlance({
  node,
  zone = "focus",
}: {
  readonly node: CanvasNode;
  readonly zone?: "focus" | "pinned";
}) {
  // Shared, not pane-local: the focus panel budgets this rail's width so the
  // xterm keeps its columns whichever way the rail sits.
  const railsOpen = use$(terminal$.railsOpenByNodeId);
  const expanded = actorRailsOpen(node.id, railsOpen).connections;
  const setExpanded = (open: boolean): void =>
    setActorRailOpen(node.id, "connections", open);
  const connections = useActorConnections(node);
  const { isActor, rows } = connections;

  if (!isActor || rows.length === 0) return null;

  const listId = `actor-connections-list-${node.id}`;

  return (
    <aside
      className={[
        "actor-edges-glance",
        expanded ? "actor-edges-glance--expanded" : "actor-edges-glance--collapsed",
      ].join(" ")}
      data-testid="actor-edges-glance"
      aria-label="Connections"
    >
      <header className="actor-edges-glance__chrome">
        {expanded ? (
          <>
            <IconButton
              size="sm"
              className="actor-edges-glance__toggle"
              title="Collapse connections"
              aria-label="Collapse connections pane"
              aria-expanded
              aria-controls={listId}
              onClick={() => setExpanded(false)}
            >
              <PanelRightClose size={15} strokeWidth={1.75} />
            </IconButton>
            <Eyebrow tone="steel" size="xs">
              connections
            </Eyebrow>
            <span className="actor-edges-glance__count" aria-hidden>
              {rows.length}
            </span>
          </>
        ) : (
          <IconButton
            size="sm"
            className="actor-edges-glance__toggle"
            title={`Expand connections (${rows.length})`}
            aria-label={`Expand connections, ${rows.length} items`}
            aria-expanded={false}
            aria-controls={listId}
            onClick={() => setExpanded(true)}
          >
            <PanelRightOpen size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </header>
      {expanded ? (
        <ConnectionsList node={node} zone={zone} listId={listId} connections={connections} />
      ) : (
        <div className="actor-edges-glance__rail" aria-hidden>
          <span className="actor-edges-glance__rail-label">connections</span>
          <span className="actor-edges-glance__count">{rows.length}</span>
        </div>
      )}
    </aside>
  );
}
