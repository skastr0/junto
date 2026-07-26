/**
 * Agent seat state plane — pure evaluation + per-binding machine.
 * Not wired to kernel yet (Phase 3/4).
 */

export type {
  AgentSeatConfidence,
  AgentSeatHookState,
  AgentSeatState,
  AgentSeatStateEvent,
} from "../../../../shared/agent-seat-state";
export {
  AGENT_SEAT_STATES,
  isAgentSeatState,
} from "../../../../shared/agent-seat-state";

export type {
  SeatEvaluation,
  SeatHarnessId,
  SeatMatcher,
  SeatRule,
  SeatRulePack,
  SeatRuleRegion,
} from "./types";

export { evaluate, FALLBACK_IDLE, type EvaluateOptions } from "./engine";
export {
  SeatStateMachine,
  SEAT_DEBOUNCE,
  shouldHoldWorkingToIdle,
  type SeatBindingConfig,
  type SeatMachineOptions,
  type SeatStateListener,
} from "./seat-state-machine";

export {
  ALL_HARNESS_IDS,
  claudeRules,
  codexRules,
  grokRules,
  hermesRules,
  isSeatHarnessId,
  rulePackFor,
} from "./rules";

export { matcherMatches, regionLines, regionText, ruleMatches } from "./match";
