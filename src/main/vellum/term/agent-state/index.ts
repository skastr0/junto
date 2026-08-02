/**
 * Agent seat state plane — pure evaluation + per-binding machine + runtime wire.
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
  claudeRules,
  codexRules,
  grokRules,
  hermesRules,
  rulePackFor,
} from "./rules";

export { matcherMatches, regionLines, regionText, ruleMatches } from "./match";

export {
  applyOscHookFromSnapshot,
  attachOscHookFeed,
  hookStateFromSnapshot,
} from "./hook-feed";

export {
  SeatStateRuntime,
  seatStateRuntime,
  type SeatStateRuntimeOptions,
} from "./runtime";
