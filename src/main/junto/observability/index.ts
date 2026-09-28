export {
  ObservabilityEffectLogger,
  ObservabilityLoggerLive,
  installObservabilityConsoleHook,
  recordRendererConsole,
  recordSystemLog,
} from "./logger";
export {
  makeObservabilityRing,
  observabilityRing,
  recordObservabilityLog,
  type ObservabilityAppendInput,
  type ObservabilityRing,
} from "./ring";
export { registerObservabilityIpc } from "./ipc";
// Only what boot needs. The rest of the budget surface is imported from
// ./main-thread-budget directly, at the call site that measures.
export {
  MAIN_THREAD_BUDGET_MS,
  armMainThreadBudget,
} from "./main-thread-budget";
