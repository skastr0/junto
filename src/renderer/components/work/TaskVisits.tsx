import { Fragment, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  History,
  ListChecks,
} from "lucide-react";
import type { Task } from "@shared/work-model";
import { Chip } from "../ui/Chip";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { state$ } from "../../lib/state";
import {
  buildTaskVisits,
  layerExitLabel,
  visitStamp,
  type VisitLayer,
} from "./task-visits";
import "./task-visits.css";

const layerTone = (layer: VisitLayer): StatusTone => {
  if (layer.live) return "amber";
  if (layer.needsRedo) return "dim";
  if (layer.exit === "sent-back") return "crimson";
  if (layer.exit === "completed") return "green";
  return "cyan";
};

function CheckRow({ check }: { readonly check: VisitLayer["checks"][number] }) {
  return (
    <li className={check.green ? "is-green" : "is-red"}>
      <StatusDot tone={check.green ? "green" : "crimson"} />
      <span className="task-visits__check-label">{check.label}</span>
      <Chip tone="steel">{check.side}</Chip>
      <code title={check.command}>{check.command}</code>
      <span className="task-visits__check-exit">exit {check.exitCode}</span>
    </li>
  );
}

function LayerInterior({ layer }: { readonly layer: VisitLayer }) {
  return (
    <div className="task-visits__interior">
      {layer.defect ? (
        <div className="task-visits__defect">
          <CircleAlert size={12} aria-hidden />
          <div>
            <strong>Sent back to {layer.defect.targetBoard}</strong>
            <p>{layer.defect.summary || "No summary was recorded."}</p>
            {layer.defect.refs.length > 0 ? (
              <ul className="task-visits__refs">
                {layer.defect.refs.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="task-visits__block">
        <h4>Claims</h4>
        {layer.receipts.length > 0 ? (
          <ul className="task-visits__receipts">
            {layer.receipts.map((receipt) => (
              <li key={`${receipt.kind}-${receipt.ruleId}`}>
                <div className="task-visits__receipt-head">
                  <Chip tone={receipt.live ? "green" : "steel"}>
                    {receipt.live ? "live" : "superseded"}
                  </Chip>
                  <Chip tone={receipt.kind === "waiver" ? "violet" : "cyan"}>
                    {receipt.kind === "waiver" ? "waived" : "answered"}
                  </Chip>
                  <strong>{receipt.ruleText ?? receipt.ruleId}</strong>
                </div>
                {receipt.provenance ? (
                  <span className="task-visits__provenance">{receipt.provenance}</span>
                ) : null}
                <p>{receipt.body}</p>
                {receipt.refs.length > 0 ? (
                  <ul className="task-visits__refs">
                    {receipt.refs.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-visits__empty">No claims recorded here.</p>
        )}
      </div>

      {layer.openRules.length > 0 ? (
        <div className="task-visits__block">
          <h4>Still open</h4>
          <ul className="task-visits__open">
            {layer.openRules.map((rule) => (
              <li key={rule.ruleId}>
                <span>{rule.text}</span>
                <span className="task-visits__provenance">{rule.provenance}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="task-visits__block">
        <h4>
          <ListChecks size={11} aria-hidden />
          Checks
        </h4>
        {layer.checks.length > 0 ? (
          <ul className="task-visits__checks">
            {layer.checks.map((check) => (
              <CheckRow key={`${check.side}-${check.checkId}-${check.at}`} check={check} />
            ))}
          </ul>
        ) : (
          <p className="task-visits__empty">No checks were stamped here.</p>
        )}
      </div>
    </div>
  );
}

function Layer({ layer }: { readonly layer: VisitLayer }) {
  const [open, setOpen] = useState(layer.live);
  const green = layer.checks.filter((check) => check.green).length;
  const red = layer.checks.length - green;
  return (
    <li
      className={[
        "task-visits__layer",
        layer.live ? "is-live" : "",
        layer.needsRedo ? "needs-redo" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`task-visits-layer-${layer.ordinal}`}
    >
      <button
        type="button"
        className="task-visits__head"
        aria-expanded={open}
        title={`Visit epoch ${layer.epoch}`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className="task-visits__ordinal">{layer.ordinal}</span>
        <StatusDot tone={layerTone(layer)} />
        <strong>{layer.board}</strong>
        <Chip tone={layer.live ? "amber" : layer.exit === "sent-back" ? "crimson" : "steel"}>
          {layerExitLabel(layer)}
        </Chip>
        {layer.needsRedo ? <Chip tone="steel">Needs redoing from here</Chip> : null}
        {!layer.needsRedo && layer.receiptState ? (
          <Chip tone={layer.receiptState === "live" ? "green" : "steel"}>
            {layer.receiptState === "live"
              ? "Claims live"
              : layer.receiptState === "mixed"
                ? "Mixed claims"
                : "Claims superseded"}
          </Chip>
        ) : null}
        <span className="task-visits__meta">
          {layer.checks.length > 0 ? (
            <span
              className={red > 0 ? "task-visits__tally is-red" : "task-visits__tally is-green"}
              title={`${green} green, ${red} red checks`}
            >
              {green}/{layer.checks.length} green
            </span>
          ) : null}
          {layer.receipts.length > 0 ? (
            <span title="Claims recorded at this board">
              {layer.receipts.length} claims
            </span>
          ) : null}
          <span title="Entered">{visitStamp(layer.enteredAt)}</span>
        </span>
      </button>

      <p className="task-visits__handoff">
        {layer.handoffNote ?? (layer.live
          ? "Working here now."
          : "No handoff note was written.")}
      </p>

      {layer.refs.length > 0 ? (
        <ul className="task-visits__refs task-visits__refs--head">
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
 * The visits: every board the task entered, current layer emphasized and
 * prior layers collapsed to their handoff note and refs. Operator-only — a
 * seat is never served prior interiors.
 */
export function TaskVisits({
  task,
  nodeId,
}: {
  readonly task: Task;
  readonly nodeId: string;
}) {
  const doc = use$(state$.doc);
  const visits = useMemo(
    () => buildTaskVisits(doc, task, nodeId),
    [doc, task, nodeId],
  );
  if (visits.layers.length === 0) return null;

  return (
    <section className="task-detail-panel__section task-visits" aria-label="Task visits">
      <h3>
        <History size={13} aria-hidden />
        Visits
        <span className="task-visits__summary">
          {visits.layers.length} visits, {visits.boardCount} boards
        </span>
      </h3>
      <ol className="task-visits__list">
        {visits.layers.map((layer) => (
          <Fragment key={layer.key}>
            {layer.epochDefect ? (
              <li
                className="task-visits__epoch"
                aria-label={`Sent back to ${layer.epochDefect.targetBoard}`}
                title={`Epoch ${layer.epoch}`}
              >
                Sent back to {layer.epochDefect.targetBoard} — claims from this board onward must be earned again
              </li>
            ) : null}
            <Layer layer={layer} />
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
