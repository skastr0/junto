import { Schema } from "effect";
import type { CanvasDoc } from "./canvas";
import { requiredBoardingChecks } from "./claims";
import { flowDestinations } from "./flow-graph";
import { TICKET_OUTPUT_TAIL_MAX_BYTES, TicketSide } from "./work-model";

// Boarding — the seat-driven half of the deterministic checks. Pure helpers
// only: resolution of the applicable checklists, output capping, and result
// shaping. Vellum Command never schedules or autonomously runs a check; the
// seat's CLI executes the commands in its own environment and submits the
// runs, and the work service stamps the tickets.

/** Per-check wall clock the seat CLI allows before abandoning a run. */
export const BOARDING_CHECK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Exit code recorded for a check the seat abandoned on timeout. 124 is the
 * conventional timeout code; the ticket stays red either way.
 */
export const BOARDING_TIMEOUT_EXIT_CODE = 124;

/** One executable check on the boarding plan, with its authored command. */
export const BoardingCheckPlan = Schema.Struct({
  checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  side: TicketSide,
  label: Schema.String,
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type BoardingCheckPlan = typeof BoardingCheckPlan.Type;

/** Source outbound checks then chosen destination inbound checks, in order. */
export const BoardingPlan = Schema.Struct({
  from: Schema.String,
  next: Schema.String,
  checks: Schema.Array(BoardingCheckPlan),
});
export type BoardingPlan = typeof BoardingPlan.Type;

export type BoardingPlanRejection = {
  readonly code: "no-destinations" | "ambiguous-next" | "unknown-destination";
  readonly message: string;
  readonly next_step: string;
  readonly destinations: ReadonlyArray<string>;
};

export type BoardingPlanResolution =
  | { readonly ok: true; readonly plan: BoardingPlan }
  | { readonly ok: false; readonly rejection: BoardingPlanRejection };

const pickDestination = (
  destinations: ReadonlyArray<string>,
  next: string | undefined,
): BoardingPlanRejection | string => {
  if (destinations.length === 0) {
    return {
      code: "no-destinations",
      message: "this sink has no task flow destinations, so nothing boards here",
      next_step:
        "draw a task flow edge from this sink, or complete the task as a terminal close",
      destinations,
    };
  }
  if (next === undefined) {
    if (destinations.length === 1) return destinations[0]!;
    return {
      code: "ambiguous-next",
      message: `this sink forwards to more than one station [${destinations.join(", ")}]`,
      next_step: "name the destination with next",
      destinations,
    };
  }
  if (!destinations.includes(next)) {
    return {
      code: "unknown-destination",
      message: `"${next}" is not a live task flow destination of this sink [${destinations.join(", ")}]`,
      next_step: "pick a destination from the live flow edges",
      destinations,
    };
  }
  return next;
};

/**
 * Resolve the applicable checklists straight from the document: the source
 * sink's outbound checks plus the chosen destination's inbound checks.
 * `next` is optional when exactly one flow destination exists.
 */
export const resolveBoardingPlan = (
  doc: CanvasDoc,
  fromNodeId: string,
  next?: string,
): BoardingPlanResolution => {
  const destinations = flowDestinations(doc, fromNodeId);
  const chosen = pickDestination(destinations, next);
  if (typeof chosen !== "string") return { ok: false, rejection: chosen };
  return {
    ok: true,
    plan: {
      from: fromNodeId,
      next: chosen,
      checks: requiredBoardingChecks(doc, fromNodeId, chosen).map(
        ({ check, side }) => ({
          checkId: check.id,
          side,
          label: check.label,
          command: check.command,
        }),
      ),
    },
  };
};

/**
 * Pick the plan for one destination out of a boarding readiness view (the
 * shape the claims read op serves). Same choose-one rule as the document
 * resolution; commands must be present or the checks cannot be run.
 */
export const planFromReadiness = (params: {
  readonly from: string;
  readonly boarding: ReadonlyArray<{
    readonly destination: string;
    readonly checks: ReadonlyArray<BoardingCheckPlan>;
  }>;
  readonly next?: string;
}): BoardingPlanResolution => {
  const destinations = params.boarding.map((entry) => entry.destination);
  const chosen = pickDestination(destinations, params.next);
  if (typeof chosen !== "string") return { ok: false, rejection: chosen };
  const entry = params.boarding.find(
    (candidate) => candidate.destination === chosen,
  );
  return {
    ok: true,
    plan: { from: params.from, next: chosen, checks: entry?.checks ?? [] },
  };
};

// ---------------------------------------------------------------------------
// Run capture and submission shaping.

const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BYTE = 0b1000_0000;

/**
 * Keep the last {@link TICKET_OUTPUT_TAIL_MAX_BYTES} bytes of UTF-8 output,
 * starting on a character boundary so the tail never opens with a partial
 * code point.
 */
export const capOutputTail = (output: string): string => {
  const bytes = new TextEncoder().encode(output);
  if (bytes.byteLength <= TICKET_OUTPUT_TAIL_MAX_BYTES) return output;
  let start = bytes.byteLength - TICKET_OUTPUT_TAIL_MAX_BYTES;
  while (
    start < bytes.byteLength &&
    (bytes[start]! & CONTINUATION_MASK) === CONTINUATION_BYTE
  ) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.subarray(start));
};

/** What the seat observed running one check locally. */
export type BoardingRun = {
  readonly checkId: string;
  readonly side: TicketSide;
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut?: boolean;
};

/** One submitted run, shaped for the tasks board op. */
export type BoardingResult = {
  readonly checkId: string;
  readonly side: TicketSide;
  readonly exitCode: number;
  readonly outputTail: string;
};

/**
 * Shape runs for submission in plan order. Runs the plan does not name are
 * dropped, since the work service stamps tickets only for applicable checks.
 */
export const shapeBoardingResults = (
  plan: BoardingPlan,
  runs: ReadonlyArray<BoardingRun>,
): ReadonlyArray<BoardingResult> =>
  plan.checks.flatMap((check) => {
    const run = runs.find(
      (candidate) =>
        candidate.checkId === check.checkId && candidate.side === check.side,
    );
    if (run === undefined) return [];
    return [
      {
        checkId: check.checkId,
        side: check.side,
        exitCode: run.exitCode,
        outputTail: capOutputTail(run.output),
      },
    ];
  });

export type BoardingRow = {
  readonly checkId: string;
  readonly side: TicketSide;
  readonly label: string;
  readonly status: "green" | "red" | "not-run";
  readonly exitCode?: number;
};

export type BoardingReport = {
  readonly from: string;
  readonly next: string;
  readonly rows: ReadonlyArray<BoardingRow>;
  /** Labels still standing between this task and the forward move. */
  readonly missing: ReadonlyArray<string>;
  readonly ready: boolean;
};

/** Per-check verdict plus what still stands in the way of forwarding. */
export const boardingReport = (
  plan: BoardingPlan,
  runs: ReadonlyArray<BoardingRun>,
): BoardingReport => {
  const rows = plan.checks.map((check): BoardingRow => {
    const run = runs.find(
      (candidate) =>
        candidate.checkId === check.checkId && candidate.side === check.side,
    );
    if (run === undefined) {
      return {
        checkId: check.checkId,
        side: check.side,
        label: check.label,
        status: "not-run",
      };
    }
    return {
      checkId: check.checkId,
      side: check.side,
      label: check.label,
      status: run.exitCode === 0 ? "green" : "red",
      exitCode: run.exitCode,
    };
  });
  const missing = rows
    .filter((row) => row.status !== "green")
    .map((row) => `${row.side} ${row.label}`);
  return {
    from: plan.from,
    next: plan.next,
    rows,
    missing,
    ready: missing.length === 0,
  };
};

const STATUS_MARK: Record<BoardingRow["status"], string> = {
  green: "green",
  red: "red",
  "not-run": "not run",
};

/** Plain text table for the seat's terminal. Machine output stays JSON. */
export const renderBoardingTable = (report: BoardingReport): string => {
  const lines = [`boarding ${report.from} -> ${report.next}`];
  const width = report.rows.reduce(
    (longest, row) => Math.max(longest, row.label.length),
    0,
  );
  for (const row of report.rows) {
    const exit = row.exitCode === undefined ? "" : ` (exit ${row.exitCode})`;
    lines.push(
      `  ${row.side.padEnd(8)} ${row.label.padEnd(width)}  ${STATUS_MARK[row.status]}${exit}`,
    );
  }
  if (report.rows.length === 0) {
    lines.push("  no boarding checks are authored for this move");
  }
  lines.push(
    report.ready
      ? "  ready to forward"
      : `  still missing: ${report.missing.join(", ")}`,
  );
  return lines.join("\n");
};
