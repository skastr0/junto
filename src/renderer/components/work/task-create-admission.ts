import { HOLD_FOR_MAX_MS } from "@shared/work-control";
import type { SinkAdmission } from "@shared/work-model";
import { parseBakeTime } from "../claims/sink-contract";

const ADMISSION_RANK: Readonly<Record<SinkAdmission, number>> = {
  auto: 0,
  "operator-gated": 1,
  "operator-owned": 2,
};

export const TASK_ADMISSION_CHOICES: ReadonlyArray<{
  readonly value: SinkAdmission;
  readonly label: string;
  readonly outcome: string;
}> = [
  { value: "auto", label: "Immediate", outcome: "Goes live immediately" },
  {
    value: "operator-gated",
    label: "Approval",
    outcome: "Waits for my approval",
  },
  {
    value: "operator-owned",
    label: "Mine",
    outcome: "I work it myself",
  },
];

export const admissionFloorOutcome = (floor: SinkAdmission): string =>
  TASK_ADMISSION_CHOICES.find((choice) => choice.value === floor)?.outcome ?? floor;

/** Creation defaults to operator approval, unless the sink floor is stricter. */
export const defaultTaskAdmission = (floor: SinkAdmission): SinkAdmission =>
  ADMISSION_RANK[floor] > ADMISSION_RANK["operator-gated"]
    ? floor
    : "operator-gated";

export const taskAdmissionChoices = (floor: SinkAdmission) =>
  TASK_ADMISSION_CHOICES.map((choice) => {
    const disabled = ADMISSION_RANK[choice.value] < ADMISSION_RANK[floor];
    return {
      ...choice,
      disabled,
      reason: disabled
        ? `Unavailable because the sink floor is “${admissionFloorOutcome(floor)}”.`
        : undefined,
    };
  });

export type TaskHoldParse =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false; readonly message: string };

export const parseTaskHold = (raw: string): TaskHoldParse => {
  const parsed = parseBakeTime(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "Use a duration such as 90m, 12h, or 7d.",
    };
  }
  if (parsed.ms !== undefined && parsed.ms > HOLD_FOR_MAX_MS) {
    return {
      ok: false,
      message: "Hold duration cannot exceed 90 days.",
    };
  }
  return parsed;
};
