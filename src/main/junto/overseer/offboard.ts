import { managedHarnessEnabled } from "@shared/features";
import { HARNESS_IDS } from "@shared/managed-terminal-templates";
import type {
  OverseerArgsFor,
  OverseerCaller,
  OverseerErrorBody,
} from "@shared/overseer-control";
import {
  offboardRulesFor,
  type OffboardRuleSet,
  type OffboardRules,
} from "@shared/seat-offboard";
import type { OverseerOffboard } from "./offboard-seam";

/**
 * `agent.offboard*`: the operator's offboard actions and rules, for an
 * overseer.
 *
 * The answers are main's, unchanged. A seat that is refused is a row in the
 * run result, not a failure of the operation: one seat that cannot be ended
 * now does not hide what happened to the others.
 */
export type OverseerOffboardRequest =
  | { readonly operation: "agent.offboard"; readonly args: OverseerArgsFor<"agent.offboard"> }
  | {
      readonly operation: "agent.offboard-status";
      readonly args: OverseerArgsFor<"agent.offboard-status">;
    }
  | { readonly operation: "agent.offboard-rules" }
  | {
      readonly operation: "agent.offboard-configure";
      readonly args: OverseerArgsFor<"agent.offboard-configure">;
    };

export type OverseerOffboardOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: OverseerErrorBody };

/** The installation's rules, and what they come to for each harness. */
export type OverseerOffboardRulesView = {
  readonly rules: OffboardRules;
  readonly effective: Readonly<Record<string, OffboardRuleSet>>;
};

export const OFFBOARD_MISSING =
  "operator offboard is not available in this build";
/** Main failed instead of answering. Its own message is not repeated. */
export const OFFBOARD_FAILED = "the offboard request could not be carried out";

export const offboardRulesView = (rules: OffboardRules): OverseerOffboardRulesView => ({
  rules,
  effective: Object.fromEntries(
    HARNESS_IDS.filter(managedHarnessEnabled).map((harness) => [
      harness,
      offboardRulesFor(rules, harness),
    ]),
  ),
});

const answer = async (
  caller: OverseerCaller,
  request: OverseerOffboardRequest,
  offboard: OverseerOffboard,
): Promise<OverseerOffboardOutcome> => {
  switch (request.operation) {
    case "agent.offboard": {
      const { canvas, nodeIds, action, mode } = request.args;
      return {
        ok: true,
        data: await offboard.run(
          {
            canvasName: canvas ?? caller.canvasName,
            seatIds: nodeIds,
            action: action ?? "ask",
            ...(mode === undefined ? {} : { mode }),
          },
          "overseer",
        ),
      };
    }
    case "agent.offboard-status": {
      const { canvas, nodeIds } = request.args;
      return {
        ok: true,
        data: await offboard.status(canvas ?? caller.canvasName, nodeIds),
      };
    }
    case "agent.offboard-rules":
      return { ok: true, data: offboardRulesView(await offboard.readRules()) };
    case "agent.offboard-configure": {
      const patched = await offboard.patchRules(request.args);
      return patched.ok
        ? { ok: true, data: offboardRulesView(patched.rules) }
        : { ok: false, error: { type: "InvalidArguments", message: patched.message } };
    }
  }
};

export const executeOverseerOffboard = (
  caller: OverseerCaller,
  request: OverseerOffboardRequest,
  offboard: OverseerOffboard | undefined,
): Promise<OverseerOffboardOutcome> =>
  offboard === undefined
    ? Promise.resolve({ ok: false, error: { type: "Unsupported", message: OFFBOARD_MISSING } })
    : answer(caller, request, offboard).catch(
        (): OverseerOffboardOutcome => ({
          ok: false,
          error: { type: "InternalError", message: OFFBOARD_FAILED },
        }),
      );
