import { useEffect, useMemo, useState } from "react";
import type { ClaimProvenance } from "@shared/claims";
import type { ClaimDef, TaskClaim } from "@shared/work-model";
import { Chip, Eyebrow } from "../../ui";
import { ClaimList } from "../ClaimList";
import { formatHops, type StationStop } from "./station-map";
import { StationStopCard } from "./StationStopCard";
import {
  claimsAt,
  formatProfile,
  groupStopsByHop,
  lineLaw,
  lineProfile,
  pinsAt,
  replacePinsAt,
  strandedPins,
} from "./station-pins";
import "./metro-map.css";

const provenanceLabel = (provenance: ClaimProvenance): string => {
  switch (provenance.kind) {
    case "region":
      return provenance.label;
    case "sink":
      return "station law";
    case "task":
      return "task law";
  }
};

export function TaskMetroMap({
  line,
  pins,
  onPinsChange,
}: {
  readonly line: ReadonlyArray<StationStop>;
  readonly pins?: ReadonlyArray<TaskClaim>;
  readonly onPinsChange?: (next: ReadonlyArray<TaskClaim>) => void;
}) {
  const pinned = useMemo(() => pins ?? [], [pins]);
  const profile = useMemo(() => lineProfile(line, pinned), [line, pinned]);
  const standingLaw = useMemo(() => lineLaw(line), [line]);
  const stages = useMemo(() => groupStopsByHop(line), [line]);
  const stranded = useMemo(() => strandedPins(pinned, line), [line, pinned]);
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const activeStop = line.find((stop) => stop.nodeId === activeStopId);

  useEffect(() => {
    if (activeStopId && !line.some((stop) => stop.nodeId === activeStopId)) {
      setActiveStopId(null);
    }
  }, [activeStopId, line]);

  if (line.length === 0) return null;

  return (
    <section className="task-metro" aria-label="Stations this task will travel">
      <header className="task-metro__head">
        <Eyebrow tone="cyan">the line this task will travel</Eyebrow>
        <span className="task-metro__profile">{formatProfile(profile)}</span>
      </header>

      {standingLaw.length > 0 ? (
        <section className="task-metro-law" aria-label="Law in force along the whole line">
          <div className="task-metro-law__head">
            <strong>In force along the whole line</strong>
            <span>answered once, wherever the work finishes</span>
          </div>
          <ul className="task-metro-law__list">
            {standingLaw.map((entry) => (
              <li key={entry.claim.id} data-severity={entry.claim.severity}>
                <span>{entry.claim.text}</span>
                <span className="task-metro-law__meta">
                  <Chip tone={entry.claim.severity === "hard" ? "amber" : "steel"}>
                    {entry.claim.severity}
                  </Chip>
                  <Chip tone={entry.provenance.kind === "region" ? "violet" : "cyan"}>
                    {provenanceLabel(entry.provenance)}
                  </Chip>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stranded.length > 0 ? (
        <p className="task-metro__stranded" role="alert">
          {`${stranded.length} pinned ${
            stranded.length === 1 ? "claim is" : "claims are"
          } addressed to a station this task can no longer reach.`}
        </p>
      ) : null}

      <ol className="task-metro__stages" data-testid="task-metro-rail">
        {stages.map((stage, stageIndex) => (
          <li
            key={stage.hops}
            className="task-metro__stage"
            data-branch={String(stage.stops.length > 1)}
            data-first={String(stageIndex === 0)}
            data-last={String(stageIndex === stages.length - 1)}
          >
            <span className="task-metro__stage-label">{formatHops(stage.hops)}</span>
            <ol className="task-metro__stage-stops">
              {stage.stops.map((stop) => {
                const stopPins = pinsAt(pinned, stop.nodeId);
                return (
                  <li key={stop.nodeId} className="task-metro__stage-stop">
                    <StationStopCard
                      stop={stop}
                      expanded={activeStopId === stop.nodeId}
                      pinCount={stopPins.length}
                      editable={onPinsChange !== undefined}
                      onToggle={() =>
                        setActiveStopId((current) =>
                          current === stop.nodeId ? null : stop.nodeId,
                        )
                      }
                    />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>

      {onPinsChange ? (
        <p className="task-metro__pin-primer">
          Open a stop to pin a claim there. A skipped branch waives only its own pins.
        </p>
      ) : null}

      {activeStop ? (
        <div
          id={`task-metro-stop-${activeStop.nodeId}`}
          className="task-metro__stop-detail"
          data-testid="task-metro-stop-detail"
        >
          {onPinsChange ? (
            <ClaimList
              ownerNodeId={activeStop.nodeId}
              claims={claimsAt(pinned, activeStop.nodeId)}
              label={`Pinned at ${activeStop.label}`}
              onChange={(claims: ReadonlyArray<ClaimDef>) =>
                onPinsChange(replacePinsAt(pinned, activeStop.nodeId, claims))
              }
            />
          ) : (
            <ul className="task-metro__readonly-pins">
              {pinsAt(pinned, activeStop.nodeId).map((pin) => (
                <li key={pin.id}>{pin.text}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
