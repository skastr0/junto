import { useMemo } from "react";
import type { ClaimDef, TaskClaim } from "@shared/work-model";
import { Eyebrow } from "../../ui";
import type { StationStop } from "./station-map";
import { StationStopCard } from "./StationStopCard";
import { formatProfile, lineProfile, replacePinsAt, strandedPins } from "./station-pins";
import "./metro-map.css";

// The line, drawn: origin on the left, every reachable station in order, each
// carrying the law it will hold the work to. Presentational — the caller reads
// the line from the document and owns the pins.

export function TaskMetroMap({
  line,
  pins,
  onPinsChange,
}: {
  readonly line: ReadonlyArray<StationStop>;
  readonly pins?: ReadonlyArray<TaskClaim>;
  /** Absent leaves the map read-only: the law is shown, nothing is pinned. */
  readonly onPinsChange?: (next: ReadonlyArray<TaskClaim>) => void;
}) {
  const pinned = useMemo(() => pins ?? [], [pins]);
  const profile = useMemo(() => lineProfile(line, pinned), [line, pinned]);
  const stranded = useMemo(() => strandedPins(pinned, line), [line, pinned]);

  if (line.length === 0) return null;

  return (
    <section className="task-metro" aria-label="Stations this task will travel">
      <header className="task-metro__head">
        <Eyebrow tone="cyan">the line this task will travel</Eyebrow>
        <span className="task-metro__profile">{formatProfile(profile)}</span>
      </header>

      {stranded.length > 0 ? (
        <p className="task-metro__stranded" role="alert">
          {`${stranded.length} pinned ${
            stranded.length === 1 ? "claim is" : "claims are"
          } addressed to a station this task can no longer reach.`}
        </p>
      ) : null}

      <ol className="task-metro__line">
        {line.map((stop, index) => (
          <li key={stop.nodeId} className="task-metro__stop" data-origin={String(stop.origin)}>
            <StationStopCard
              stop={stop}
              first={index === 0}
              last={index === line.length - 1}
              pins={pinned}
              {...(onPinsChange
                ? {
                    onPinsChange: (claims: ReadonlyArray<ClaimDef>) =>
                      onPinsChange(replacePinsAt(pinned, stop.nodeId, claims)),
                  }
                : {})}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
