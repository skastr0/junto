import { Layers } from "lucide-react";
import type { ClosedTaskLayer } from "@shared/task-model";
import { StampTally } from "../ui";
import { reviewTally } from "../../lib/task-ui";
import { agoLabel } from "./tasks-pane-model";
import type { SeatChoice } from "../../lib/task-ui";

/**
 * The onion timeline (plan 04 "Pipelines and layers"): one row per node the
 * task passed through, oldest first, each with who held it, its stamps and
 * when it was sent on. The layer the task is on now is the main pane itself.
 */
export function TaskLayers({
  layers,
  nodeName,
  seats,
  nameOf,
  now,
}: {
  readonly layers: ReadonlyArray<ClosedTaskLayer>;
  readonly nodeName: (node: string) => string;
  readonly seats: ReadonlyArray<SeatChoice>;
  readonly nameOf?: (seat: string) => string;
  readonly now: number;
}) {
  if (layers.length === 0) return null;
  const seatName = (id: string | undefined): string =>
    id === undefined ? "nobody" : (seats.find((seat) => seat.node === id)?.name ?? nameOf?.(id) ?? id);
  return (
    <section className="task-layers" aria-label="Earlier layers" data-testid="task-layers">
      <header className="task-layers__head">
        <Layers size={13} aria-hidden />
        <span>Earlier layers, {layers.length}</span>
      </header>
      <ol className="task-layers__list">
        {layers.map((layer, index) => (
          <li key={`${layer.node}-${layer.closedAt}-${index}`} className="task-layers__row">
            <strong>{nodeName(layer.node)}</strong>
            <span>{seatName(layer.assignee)}</span>
            {layer.stampPolicy.required > 0 ? <StampTally tally={reviewTally(layer)} /> : null}
            <span className="task-layers__age">sent {agoLabel(layer.closedAt, now)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
