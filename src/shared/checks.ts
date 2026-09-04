import { Schema } from "effect";
import type { CanvasDoc } from "./canvas";
import { requiredChecks } from "./rules";
import { flowDestinations } from "./flow-graph";
import { CHECK_OUTPUT_TAIL_MAX_BYTES, CheckSide } from "./work-model";

// Agent-run task checks. Vellum Command resolves the applicable commands and
// records submitted results; it never runs a check autonomously.

export const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
export const CHECK_TIMEOUT_EXIT_CODE = 124;

export const CheckPlanItem = Schema.Struct({
  checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  side: CheckSide,
  label: Schema.String,
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type CheckPlanItem = typeof CheckPlanItem.Type;

export const CheckPlan = Schema.Struct({
  from: Schema.String,
  next: Schema.String,
  checks: Schema.Array(CheckPlanItem),
});
export type CheckPlan = typeof CheckPlan.Type;

export type CheckPlanRejection = {
  readonly code: "no-destinations" | "ambiguous-next" | "unknown-destination";
  readonly message: string;
  readonly next_step: string;
  readonly destinations: ReadonlyArray<string>;
};

export type CheckPlanResolution =
  | { readonly ok: true; readonly plan: CheckPlan }
  | { readonly ok: false; readonly rejection: CheckPlanRejection };

const pickDestination = (
  destinations: ReadonlyArray<string>,
  next: string | undefined,
): CheckPlanRejection | string => {
  if (destinations.length === 0) {
    return {
      code: "no-destinations",
      message: "this board has no next board",
      next_step: "connect a next Tasks board or complete the task here",
      destinations,
    };
  }
  if (next === undefined) {
    if (destinations.length === 1) return destinations[0]!;
    return {
      code: "ambiguous-next",
      message: `this board has more than one Next [${destinations.join(", ")}]`,
      next_step: "name the next board",
      destinations,
    };
  }
  if (!destinations.includes(next)) {
    return {
      code: "unknown-destination",
      message: `"${next}" is not a next board [${destinations.join(", ")}]`,
      next_step: "choose a board from the current path",
      destinations,
    };
  }
  return next;
};

export const resolveCheckPlan = (
  doc: CanvasDoc,
  fromNodeId: string,
  next?: string,
): CheckPlanResolution => {
  const destinations = flowDestinations(doc, fromNodeId);
  const chosen = pickDestination(destinations, next);
  if (typeof chosen !== "string") return { ok: false, rejection: chosen };
  return {
    ok: true,
    plan: {
      from: fromNodeId,
      next: chosen,
      checks: requiredChecks(doc, fromNodeId, chosen).map(({ check, side }) => ({
        checkId: check.id,
        side,
        label: check.label,
        command: check.command,
      })),
    },
  };
};

export const planFromReadiness = (params: {
  readonly from: string;
  readonly checks: ReadonlyArray<{
    readonly destination: string;
    readonly checks: ReadonlyArray<CheckPlanItem>;
  }>;
  readonly next?: string;
}): CheckPlanResolution => {
  const destinations = params.checks.map((entry) => entry.destination);
  const chosen = pickDestination(destinations, params.next);
  if (typeof chosen !== "string") return { ok: false, rejection: chosen };
  const entry = params.checks.find((candidate) => candidate.destination === chosen);
  return {
    ok: true,
    plan: { from: params.from, next: chosen, checks: entry?.checks ?? [] },
  };
};

const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BYTE = 0b1000_0000;

export const capOutputTail = (output: string): string => {
  const bytes = new TextEncoder().encode(output);
  if (bytes.byteLength <= CHECK_OUTPUT_TAIL_MAX_BYTES) return output;
  let start = bytes.byteLength - CHECK_OUTPUT_TAIL_MAX_BYTES;
  while (
    start < bytes.byteLength &&
    (bytes[start]! & CONTINUATION_MASK) === CONTINUATION_BYTE
  ) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.subarray(start));
};

export type CheckRun = {
  readonly checkId: string;
  readonly side: CheckSide;
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut?: boolean;
};

export type CheckSubmissionResult = {
  readonly checkId: string;
  readonly side: CheckSide;
  readonly exitCode: number;
  readonly outputTail: string;
};

export const shapeCheckResults = (
  plan: CheckPlan,
  runs: ReadonlyArray<CheckRun>,
): ReadonlyArray<CheckSubmissionResult> =>
  plan.checks.flatMap((check) => {
    const run = runs.find(
      (candidate) =>
        candidate.checkId === check.checkId && candidate.side === check.side,
    );
    if (run === undefined) return [];
    return [{
      checkId: check.checkId,
      side: check.side,
      exitCode: run.exitCode,
      outputTail: capOutputTail(run.output),
    }];
  });

export type CheckReportRow = {
  readonly checkId: string;
  readonly side: CheckSide;
  readonly label: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly exitCode?: number;
};

export type CheckReport = {
  readonly from: string;
  readonly next: string;
  readonly rows: ReadonlyArray<CheckReportRow>;
  readonly missing: ReadonlyArray<string>;
  readonly ready: boolean;
};

export const checkReport = (
  plan: CheckPlan,
  runs: ReadonlyArray<CheckRun>,
): CheckReport => {
  const rows = plan.checks.map((check): CheckReportRow => {
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
      status: run.exitCode === 0 ? "passed" : "failed",
      exitCode: run.exitCode,
    };
  });
  const missing = rows
    .filter((row) => row.status !== "passed")
    .map((row) => `${row.side} ${row.label}`);
  return {
    from: plan.from,
    next: plan.next,
    rows,
    missing,
    ready: missing.length === 0,
  };
};
