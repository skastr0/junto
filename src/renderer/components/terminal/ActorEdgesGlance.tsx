/**
 * Outside-the-plate right-rail edge inventory for an actor on focus.
 * Mounted as FocusSurface `aside` (sibling of the modal panel) so the TUI
 * stays unobscured while the operator still sees connected sinks + edge nature.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import {
  actorEdgeNatureLabel,
  actorEdgeRows,
  type ActorEdgeRow,
} from "../../lib/actor-edges";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import { Chip, Eyebrow, type ChipTone } from "../ui";

const natureTone = (row: ActorEdgeRow): ChipTone => {
  if (row.livePhase === "blocks" || row.nature === "tasks") return "crimson";
  if (row.nature === "proof" || row.nature === "approval") return "violet";
  return "steel";
};

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
  const nature = actorEdgeNatureLabel(row);
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
    `edge ${nature}`,
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
      data-edge-nature={row.nature}
      data-live-phase={row.livePhase ?? undefined}
      title={title}
    >
      <div className="actor-edges-glance__row-head">
        <DirectionMark direction={row.direction} />
        <span className="actor-edges-glance__kind">{row.peerKind}</span>
        <Chip tone={natureTone(row)} title={`edge - ${nature}`}>
          {nature}
        </Chip>
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
      className="actor-edges-glance"
      data-testid="actor-edges-glance"
      role="region"
      aria-label="Connected edges"
    >
      <header className="actor-edges-glance__chrome">
        <Eyebrow tone="steel" size="xs">
          edges
        </Eyebrow>
        <span className="actor-edges-glance__count" aria-hidden>
          {rows.length}
        </span>
      </header>
      <ul className="actor-edges-glance__list">
        {rows.map((row) => (
          <EdgeCard key={row.edgeId} row={row} />
        ))}
      </ul>
    </aside>
  );
}
