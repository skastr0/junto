import type {
  OverseerArgsFor,
  OverseerCaller,
  OverseerErrorBody,
  OverseerOffboardAction,
} from "@shared/overseer-control";
import type { OverseerOffboard, OverseerOffboardSeatResult } from "./offboard-seam";

/**
 * `agent.offboard*`: the operator's offboard actions and rules, for an
 * overseer.
 *
 * Each seat gets its own answer, in the order asked. A seat that is refused
 * is a row in the result, not a failure of the operation: one seat that
 * cannot be ended now does not hide what happened to the others.
 */
export type OverseerOffboardRow =
  | {
      readonly nodeId: string;
      readonly title?: string;
      readonly ok: true;
      readonly action: OverseerOffboardAction;
      readonly outcome: string;
    }
  | {
      readonly nodeId: string;
      readonly title?: string;
      readonly ok: false;
      readonly reason: string;
    };

export type OverseerOffboardResult = {
  readonly results: ReadonlyArray<OverseerOffboardRow>;
  readonly refused: number;
};

export type OverseerOffboardOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: OverseerErrorBody };

export const OFFBOARD_MISSING =
  "operator offboard is not available in this build";
export const OFFBOARD_OWN_SEAT = "this is your own seat: run junto offboard";
/** Main threw instead of answering. Its message is not repeated. */
export const OFFBOARD_SEAT_FAILED = "Junto could not offboard this seat.";
const OFFBOARD_RULES_FAILED = "the offboard rules could not be read or changed";

const withTitle = (title: string | undefined): { readonly title?: string } =>
  title === undefined ? {} : { title };

export const offboardSeats = async (
  caller: OverseerCaller,
  args: OverseerArgsFor<"agent.offboard">,
  offboard: OverseerOffboard,
): Promise<OverseerOffboardResult> => {
  const canvasName = args.canvas ?? caller.canvasName;
  const action = args.action ?? "ask";
  const mode = args.mode ?? "continue";
  const results: OverseerOffboardRow[] = [];
  // One at a time, in the order asked: the same pace as the operator's clicks.
  for (const nodeId of args.nodeIds) {
    // An agent offboards its own session with its own notes; mail to itself
    // asking for that would only arrive in the turn that sent it.
    if (
      action === "ask" &&
      canvasName === caller.canvasName &&
      nodeId === caller.nodeId
    ) {
      results.push({ nodeId, ok: false, reason: OFFBOARD_OWN_SEAT });
      continue;
    }
    const answer = await offboard
      .seat({ canvasName, nodeId, action, mode })
      .catch((): OverseerOffboardSeatResult => ({ ok: false, reason: OFFBOARD_SEAT_FAILED }));
    results.push(
      answer.ok
        ? { nodeId, ...withTitle(answer.title), ok: true, action, outcome: answer.outcome }
        : { nodeId, ...withTitle(answer.title), ok: false, reason: answer.reason },
    );
  }
  return { results, refused: results.filter((row) => !row.ok).length };
};

export const executeOverseerOffboard = async (
  caller: OverseerCaller,
  request:
    | { readonly operation: "agent.offboard"; readonly args: OverseerArgsFor<"agent.offboard"> }
    | { readonly operation: "agent.offboard-rules" }
    | {
        readonly operation: "agent.offboard-configure";
        readonly args: OverseerArgsFor<"agent.offboard-configure">;
      },
  offboard: OverseerOffboard | undefined,
): Promise<OverseerOffboardOutcome> => {
  if (offboard === undefined) {
    return { ok: false, error: { type: "Unsupported", message: OFFBOARD_MISSING } };
  }
  try {
    switch (request.operation) {
      case "agent.offboard":
        return { ok: true, data: await offboardSeats(caller, request.args, offboard) };
      case "agent.offboard-rules":
        return { ok: true, data: await offboard.rules() };
      case "agent.offboard-configure":
        return { ok: true, data: await offboard.configure(request.args) };
    }
  } catch {
    return { ok: false, error: { type: "InternalError", message: OFFBOARD_RULES_FAILED } };
  }
};
