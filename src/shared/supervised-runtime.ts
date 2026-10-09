export type SupervisedInstallState = "installed" | "absent" | "unknown";

export type SupervisedRuntimeInput = {
  readonly machineName: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
};

export type SupervisedRuntimeAssessment = {
  readonly machineName: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
  /** Preferred intent matches observed install (unknown is never aligned when preferred). */
  readonly aligned: boolean;
  readonly status: "ok" | "warning";
  readonly detail: string;
  /** ServiceCheck.metadata — all string values. */
  readonly metadata: Readonly<Record<string, string>>;
};

/**
 * Pure reconciliation of supervision preference vs supervisor state.
 * No I/O — callers probe launchctl (or inject a test double).
 */
export const assessSupervisedRuntime = (
  input: SupervisedRuntimeInput,
): SupervisedRuntimeAssessment => {
  const machineName = input.machineName;
  const preferred = input.supervisedPreferred;
  const installed = input.supervisedInstalled;

  let aligned: boolean;
  let status: "ok" | "warning";
  let detail: string;

  if (installed === "unknown") {
    aligned = !preferred;
    if (preferred) {
      status = "warning";
      detail = "supervised preferred but supervisor state unknown";
    } else {
      status = "ok";
      detail = "supervised not preferred; supervisor state unknown";
    }
  } else if (preferred && installed === "installed") {
    aligned = true;
    status = "ok";
    detail = "supervised preferred and supervisor loaded";
  } else if (!preferred && installed === "absent") {
    aligned = true;
    status = "ok";
    detail = "unsupervised preferred; supervisor absent";
  } else if (preferred && installed === "absent") {
    aligned = false;
    status = "warning";
    detail = "supervised preferred but supervisor not loaded — run bun run app:install:supervised";
  } else {
    aligned = false;
    status = "ok";
    detail = "supervisor loaded; preference is unsupervised";
  }

  return {
    machineName,
    supervisedPreferred: preferred,
    supervisedInstalled: installed,
    aligned,
    status,
    detail,
    metadata: {
      machineName,
      supervisedPreferred: preferred ? "true" : "false",
      supervisedInstalled: installed,
      supervisedAligned: aligned ? "true" : "false",
    },
  };
};
