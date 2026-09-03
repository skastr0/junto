import { Fragment, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Route,
  TicketCheck,
} from "lucide-react";
import type { Task } from "@shared/work-model";
import { Chip } from "../ui/Chip";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { state$ } from "../../lib/state";
import {
  buildTaskJourney,
  journeyStamp,
  layerExitLabel,
  type JourneyLayer,
} from "./task-journey";
import "./task-journey.css";

const layerTone = (layer: JourneyLayer): StatusTone => {
  if (layer.live) return "amber";
  if (layer.needsRedo) return "dim";
  if (layer.exit === "rejected-back") return "crimson";
  if (layer.exit === "closed") return "green";
  return "cyan";
};

function TicketRow({ ticket }: { readonly ticket: JourneyLayer["tickets"][number] }) {
  return (
    <li className={ticket.green ? "is-green" : "is-red"}>
      <StatusDot tone={ticket.green ? "green" : "crimson"} />
      <span className="task-journey__ticket-label">{ticket.label}</span>
      <Chip tone="steel">{ticket.side}</Chip>
      <code title={ticket.command}>{ticket.command}</code>
      <span className="task-journey__ticket-exit">exit {ticket.exitCode}</span>
    </li>
  );
}

function LayerInterior({ layer }: { readonly layer: JourneyLayer }) {
  return (
    <div className="task-journey__interior">
      {layer.defect ? (
        <div className="task-journey__defect">
          <CircleAlert size={12} aria-hidden />
          <div>
            <strong>Sent back to {layer.defect.targetStation}</strong>
            <p>{layer.defect.summary || "No summary was recorded."}</p>
            {layer.defect.refs.length > 0 ? (
              <ul className="task-journey__refs">
                {layer.defect.refs.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="task-journey__block">
        <h4>Claim responses</h4>
        {layer.receipts.length > 0 ? (
          <ul className="task-journey__receipts">
            {layer.receipts.map((receipt) => (
              <li key={`${receipt.kind}-${receipt.claimId}`}>
                <div className="task-journey__receipt-head">
                  <Chip tone={receipt.live ? "green" : "steel"}>
                    {receipt.live ? "live" : "superseded"}
                  </Chip>
                  <Chip tone={receipt.kind === "waiver" ? "violet" : "cyan"}>
                    {receipt.kind === "waiver" ? "waived" : "answered"}
                  </Chip>
                  {receipt.severity ? (
                    <Chip tone={receipt.severity === "hard" ? "crimson" : "steel"}>
                      {receipt.severity === "hard" ? "Required" : "Optional"}
                    </Chip>
                  ) : null}
                  <strong>{receipt.claimText ?? receipt.claimId}</strong>
                </div>
                {receipt.provenance ? (
                  <span className="task-journey__provenance">{receipt.provenance}</span>
                ) : null}
                <p>{receipt.body}</p>
                {receipt.refs.length > 0 ? (
                  <ul className="task-journey__refs">
                    {receipt.refs.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-journey__empty">No claim responses recorded here.</p>
        )}
      </div>

      {layer.openClaims.length > 0 ? (
        <div className="task-journey__block">
          <h4>Still open</h4>
          <ul className="task-journey__open">
            {layer.openClaims.map((claim) => (
              <li key={claim.claimId}>
                <Chip tone={claim.severity === "hard" ? "crimson" : "steel"}>
                  {claim.severity === "hard" ? "Required" : "Optional"}
                </Chip>
                <span>{claim.text}</span>
                <span className="task-journey__provenance">{claim.provenance}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="task-journey__block">
        <h4>
          <TicketCheck size={11} aria-hidden />
          Boarding tickets
        </h4>
        {layer.tickets.length > 0 ? (
          <ul className="task-journey__tickets">
            {layer.tickets.map((ticket) => (
              <TicketRow key={`${ticket.side}-${ticket.checkId}-${ticket.at}`} ticket={ticket} />
            ))}
          </ul>
        ) : (
          <p className="task-journey__empty">No boarding checks were stamped here.</p>
        )}
      </div>
    </div>
  );
}

function Layer({ layer }: { readonly layer: JourneyLayer }) {
  const [open, setOpen] = useState(layer.live);
  const green = layer.tickets.filter((ticket) => ticket.green).length;
  const red = layer.tickets.length - green;
  return (
    <li
      className={[
        "task-journey__layer",
        layer.live ? "is-live" : "",
        layer.needsRedo ? "needs-redo" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`task-journey-layer-${layer.ordinal}`}
    >
      <button
        type="button"
        className="task-journey__head"
        aria-expanded={open}
        title={`Passage epoch ${layer.epoch}`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className="task-journey__ordinal">{layer.ordinal}</span>
        <StatusDot tone={layerTone(layer)} />
        <strong>{layer.station}</strong>
        <Chip tone={layer.live ? "amber" : layer.exit === "rejected-back" ? "crimson" : "steel"}>
          {layerExitLabel(layer)}
        </Chip>
        {layer.needsRedo ? <Chip tone="steel">Needs redoing from here</Chip> : null}
        {!layer.needsRedo && layer.receiptState ? (
          <Chip tone={layer.receiptState === "live" ? "green" : "steel"}>
            {layer.receiptState === "live"
              ? "Receipts live"
              : layer.receiptState === "mixed"
                ? "Mixed receipts"
                : "Receipts superseded"}
          </Chip>
        ) : null}
        <span className="task-journey__meta">
          {layer.tickets.length > 0 ? (
            <span
              className={red > 0 ? "task-journey__tally is-red" : "task-journey__tally is-green"}
              title={`${green} green, ${red} red boarding tickets`}
            >
              {green}/{layer.tickets.length} green
            </span>
          ) : null}
          {layer.receipts.length > 0 ? (
            <span title="Claim responses recorded at this station">
              {layer.receipts.length} receipts
            </span>
          ) : null}
          <span title="Arrived">{journeyStamp(layer.enteredAt)}</span>
        </span>
      </button>

      <p className="task-journey__emission">
        {layer.emissionNote ?? (layer.live
          ? "Working here now."
          : "No emission note was published.")}
      </p>

      {layer.refs.length > 0 ? (
        <ul className="task-journey__refs task-journey__refs--head">
          {layer.refs.map((ref) => (
            <li key={ref}>{ref}</li>
          ))}
        </ul>
      ) : null}

      {open ? <LayerInterior layer={layer} /> : null}
    </li>
  );
}

/**
 * The onion: every passage the task made, current layer emphasized and prior
 * layers collapsed to their emission and refs. Operator-only — a seat is never
 * served prior interiors.
 */
export function TaskJourney({
  task,
  nodeId,
}: {
  readonly task: Task;
  readonly nodeId: string;
}) {
  const doc = use$(state$.doc);
  const journey = useMemo(
    () => buildTaskJourney(doc, task, nodeId),
    [doc, task, nodeId],
  );
  if (journey.layers.length === 0) return null;

  return (
    <section className="task-detail-panel__section task-journey" aria-label="Task journey">
      <h3>
        <Route size={13} aria-hidden />
        Journey
        <span className="task-journey__summary">
          {journey.layers.length} passages, {journey.stationCount} stations
        </span>
      </h3>
      <ol className="task-journey__list">
        {journey.layers.map((layer) => (
          <Fragment key={layer.key}>
            {layer.epochDefect ? (
              <li
                className="task-journey__epoch"
                aria-label={`Sent back to ${layer.epochDefect.targetStation}`}
                title={`Epoch ${layer.epoch}`}
              >
                Sent back to {layer.epochDefect.targetStation} — receipts from this stop onward must be earned again
              </li>
            ) : null}
            <Layer layer={layer} />
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
