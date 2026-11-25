/** Test-observability stage stamps on the system clock; inert unless a harness installs a sink or asks for stdout. */
export type PerfStageEvent = {
  readonly t: number;
  readonly process: "renderer" | "main" | "core";
  readonly stage: string;
  readonly op?: string;
  readonly id?: string | number;
  readonly label?: string;
};

const enabled = (): boolean => {
  const sink = (globalThis as { __juntoPerfStages?: unknown }).__juntoPerfStages;
  if (Array.isArray(sink)) return true;
  return typeof process !== "undefined" && process.env.JUNTO_PERF_STAGES === "1";
};

export const perfStageEnabled = enabled;

export const perfStage = (
  processName: PerfStageEvent["process"],
  stage: string,
  detail: Omit<PerfStageEvent, "t" | "process" | "stage"> = {},
): void => {
  if (!enabled()) return;
  const event: PerfStageEvent = { t: Date.now(), process: processName, stage, ...detail };
  const sink = (globalThis as { __juntoPerfStages?: unknown }).__juntoPerfStages;
  if (Array.isArray(sink)) sink.push(event);
  if (typeof process !== "undefined" && process.env.JUNTO_PERF_STAGES === "1") console.log(`PERF-STAGE ${JSON.stringify(event)}`);
};
