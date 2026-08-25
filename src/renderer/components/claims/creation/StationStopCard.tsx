import { ChevronDown, Flag, GitFork, Timer } from "lucide-react";
import { Chip, type ChipTone } from "../../ui";
import { formatBakeTime } from "../sink-contract";
import { admissionLabel, formatHops, type StationStop } from "./station-map";

const ADMISSION_TONE: Readonly<Record<StationStop["admission"], ChipTone>> = {
  auto: "steel",
  "operator-gated": "violet",
  "operator-owned": "cyan",
};

/** One compact stop. Details are intentionally limited to its pinned claims. */
export function StationStopCard({
  stop,
  expanded,
  pinCount,
  editable,
  onToggle,
}: {
  readonly stop: StationStop;
  readonly expanded: boolean;
  readonly pinCount: number;
  readonly editable: boolean;
  readonly onToggle: () => void;
}) {
  const bake = formatBakeTime(stop.bakeMs);
  return (
    <button
      type="button"
      className="task-metro-stop"
      data-origin={String(stop.origin)}
      data-terminal={String(stop.terminal)}
      data-expanded={String(expanded)}
      aria-expanded={expanded}
      aria-controls={`task-metro-stop-${stop.nodeId}`}
      aria-label={`${stop.label}, ${formatHops(stop.hops)}${
        stop.terminal ? ", terminal stop" : ""
      }${pinCount > 0 ? `, ${pinCount} pinned` : ""}`}
      onClick={onToggle}
    >
      <span className="task-metro-stop__dot" aria-hidden />
      <span className="task-metro-stop__body">
        <strong className="task-metro-stop__name" title={stop.label}>
          {stop.label}
        </strong>
        <span className="task-metro-stop__marks">
          {stop.admission !== "auto" ? (
            <Chip tone={ADMISSION_TONE[stop.admission]}>
              {admissionLabel(stop.admission)}
            </Chip>
          ) : null}
          {bake ? (
            <Chip tone="steel">
              <Timer size={9} aria-hidden />
              {bake}
            </Chip>
          ) : null}
          {stop.destinations.length > 1 ? (
            <Chip tone="steel">
              <GitFork size={9} aria-hidden />
              {stop.destinations.length} ways
            </Chip>
          ) : null}
          {stop.terminal ? (
            <span className="task-metro-stop__terminal" title="Terminal stop">
              <Flag size={10} aria-hidden />
            </span>
          ) : null}
          {pinCount > 0 ? <Chip tone="amber">{`${pinCount} pinned`}</Chip> : null}
        </span>
      </span>
      {editable || pinCount > 0 ? (
        <ChevronDown className="task-metro-stop__chevron" size={12} aria-hidden />
      ) : null}
    </button>
  );
}
