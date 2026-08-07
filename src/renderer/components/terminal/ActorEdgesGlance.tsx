/**
 * Right side-pane edge inventory for an actor terminal surface.
 *
 * Sits to the right of the xterm stage inside the same modal plate (not a
 * horizontal strip under the header, not a floating FocusSurface aside).
 * Collapse / expand; still present when pinned.
 *
 * No "soft" / "tasks" edge nature — those were authorial relationship modes.
 * Live stoppage is a derived chip only when the kernel reports blocks.
 */
import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  actorEdgePhaseLabel,
  actorEdgeRows,
  type ActorEdgeRow,
} from "../../lib/actor-edges";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import { Chip, Eyebrow, IconButton } from "../ui";

const DirectionMark = ({ direction }: { readonly direction: "out" | "in" }) => (
  <span
    className="actor-edges-glance__dir"
    aria-hidden
    title={direction === "out" ? "Outbound" : "Inbound"}
  >
    {direction === "out" ? "→" : "←"}
  </span>
);

function EdgeCard({ row }: { readonly row: ActorEdgeRow }) {
  const phase = actorEdgePhaseLabel(row);
  const ports =
    row.ports.length > 0
      ? row.ports.map((p) => p.replace(/^[a-z]+\./, "")).join(" - ")
      : null;
  const meta: string[] = [];
  if (row.boardNotify === "on") meta.push("wakes");
  if (row.boardNotify === "off") meta.push("wakes off");
  const title = [
    `${row.direction === "out" ? "to" : "from"} ${row.peerTitle}`,
    `kind ${row.peerKind}`,
    phase ? `live ${phase}` : null,
    ports ? `ports ${row.ports.join(" - ")}` : null,
    ...meta,
  ]
    .filter(Boolean)
    .join(" - ");

  return (
    <li
      className="actor-edges-glance__row"
      data-edge-id={row.edgeId}
      data-peer-kind={row.peerKind}
      data-live-phase={row.livePhase ?? undefined}
      title={title}
    >
      <div className="actor-edges-glance__row-head">
        <DirectionMark direction={row.direction} />
        <span className="actor-edges-glance__kind">{row.peerKind}</span>
        {phase ? (
          <Chip tone="crimson" title="live stoppage">
            {phase}
          </Chip>
        ) : null}
      </div>
      <span className="actor-edges-glance__title">{row.peerTitle}</span>
      {ports ? (
        <span className="actor-edges-glance__ports" title={row.ports.join(" - ")}>
          {ports}
        </span>
      ) : null}
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
    </li>
  );
}

/**
 * Renders only for actor-role nodes with at least one incident edge.
 * Read-only: no edge editing here (inspector / RTS kind surface own that).
 */
export function ActorEdgesGlance({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const [expanded, setExpanded] = useState(true);

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

  if (!isActor || rows.length === 0) return null;

  return (
    <aside
      className={[
        "actor-edges-glance",
        expanded ? "actor-edges-glance--expanded" : "actor-edges-glance--collapsed",
      ].join(" ")}
      data-testid="actor-edges-glance"
      aria-label="Connected edges"
    >
      <header className="actor-edges-glance__chrome">
        {expanded ? (
          <>
            <Eyebrow tone="steel" size="xs">
              edges
            </Eyebrow>
            <span className="actor-edges-glance__count" aria-hidden>
              {rows.length}
            </span>
            <IconButton
              size="sm"
              title="Collapse edges pane"
              aria-label="Collapse edges pane"
              aria-expanded
              aria-controls={`actor-edges-list-${node.id}`}
              onClick={() => setExpanded(false)}
            >
              <ChevronRight size={14} />
            </IconButton>
          </>
        ) : (
          <IconButton
            size="sm"
            title={`Expand edges (${rows.length})`}
            aria-label={`Expand edges, ${rows.length} connections`}
            aria-expanded={false}
            aria-controls={`actor-edges-list-${node.id}`}
            onClick={() => setExpanded(true)}
          >
            <ChevronLeft size={14} />
          </IconButton>
        )}
      </header>
      {expanded ? (
        <ul
          id={`actor-edges-list-${node.id}`}
          className="actor-edges-glance__list"
        >
          {rows.map((row) => (
            <EdgeCard key={row.edgeId} row={row} />
          ))}
        </ul>
      ) : (
        <div className="actor-edges-glance__rail" aria-hidden>
          <span className="actor-edges-glance__rail-label">edges</span>
          <span className="actor-edges-glance__count">{rows.length}</span>
        </div>
      )}
    </aside>
  );
}
