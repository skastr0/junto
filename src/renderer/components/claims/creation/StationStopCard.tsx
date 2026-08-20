import type { ClaimDef, TaskClaim } from "@shared/work-model";
import type { ClaimProvenance } from "@shared/claims";
import { Chip, type ChipTone } from "../../ui";
import { ClaimList } from "../ClaimList";
import { formatBakeTime } from "../sink-contract";
import { admissionLabel, formatHops, type StationStop } from "./station-map";
import { claimsAt } from "./station-pins";

// One stop on the creation metro map: what this station stands for, the law
// already standing there with its provenance, and the claims this task pins
// to it. Reading a stop should answer "what will be asked of the work here?"
// before a single word of the brief is written.

const ADMISSION_TONE: Readonly<Record<StationStop["admission"], ChipTone>> = {
  auto: "steel",
  "operator-gated": "violet",
  "operator-owned": "cyan",
};

const provenanceChip = (
  provenance: ClaimProvenance,
): { readonly tone: ChipTone; readonly label: string } => {
  switch (provenance.kind) {
    case "region":
      return { tone: "violet", label: provenance.label };
    case "sink":
      return { tone: "cyan", label: "station law" };
    case "task":
      return { tone: "amber", label: "pinned" };
  }
};

export function StationStopCard({
  stop,
  first,
  last,
  pins,
  onPinsChange,
}: {
  readonly stop: StationStop;
  readonly first: boolean;
  readonly last: boolean;
  /** Station-addressed claims already pinned to this stop. */
  readonly pins?: ReadonlyArray<TaskClaim>;
  /** Absent when the line is read-only: no pin affordance is offered. */
  readonly onPinsChange?: (next: ReadonlyArray<ClaimDef>) => void;
}) {
  const bake = formatBakeTime(stop.bakeMs);
  const pinned = pins ?? [];

  return (
    <>
      <div className="task-metro__rail" aria-hidden>
        <span
          className="task-metro__track"
          data-side="in"
          data-open={String(!first)}
          data-linked={String(stop.linkedToPrevious)}
        />
        <span
          className="task-metro__dot"
          data-tone={stop.origin ? "origin" : stop.terminal ? "terminal" : "stop"}
        />
        <span className="task-metro__track" data-side="out" data-open={String(!last)} />
      </div>

      <div>
        <div className="task-metro__where">{formatHops(stop.hops)}</div>
        <h4 className="task-metro__name" title={stop.label}>
          {stop.label}
        </h4>
      </div>

      <div className="task-metro__card">
        <div className="task-metro__marks">
          <Chip tone={ADMISSION_TONE[stop.admission]} title="How arrivals become claimable here">
            {admissionLabel(stop.admission)}
          </Chip>
          {bake ? <Chip tone="steel" title="Arrivals bake before anyone can claim them">{`bakes ${bake}`}</Chip> : null}
          {stop.terminal ? (
            <Chip tone="green" title="Nothing downstream, work closes at this stop">
              closes here
            </Chip>
          ) : stop.destinations.length > 1 ? (
            <Chip tone="steel" title="Forwarding from here is choose one">
              {`forks ${stop.destinations.length} ways`}
            </Chip>
          ) : null}
        </div>

        {stop.instruction ? (
          <p className="task-metro__prose" data-kind="instruction">
            {stop.instruction}
          </p>
        ) : null}
        {stop.description ? (
          <p className="task-metro__prose">{`Takes in: ${stop.description}`}</p>
        ) : null}
        {stop.triage ? <p className="task-metro__prose">{stop.triage}</p> : null}

        {stop.law.length > 0 ? (
          <ul className="task-metro__law">
            {stop.law.map((entry) => {
              const chip = provenanceChip(entry.provenance);
              return (
                <li
                  key={`${entry.provenance.kind}:${entry.claim.id}`}
                  className="task-metro-claim"
                  data-severity={entry.claim.severity}
                >
                  <p className="task-metro-claim__text">{entry.claim.text}</p>
                  <span className="task-metro-claim__meta">
                    <Chip tone={entry.claim.severity === "hard" ? "amber" : "steel"}>
                      {entry.claim.severity}
                    </Chip>
                    <Chip tone={chip.tone}>{chip.label}</Chip>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="task-metro__empty">No standing law at this stop.</p>
        )}

        {onPinsChange ? (
          <div className="task-metro__pins">
            <ClaimList
              ownerNodeId={stop.nodeId}
              claims={claimsAt(pinned, stop.nodeId)}
              label="pin to this stop"
              hint="Answered when the work reaches here, or waived if the route skips it."
              onChange={onPinsChange}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
