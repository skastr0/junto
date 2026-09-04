import { WAIT_FOR_MAX_MS } from "@shared/work-control";
import type { TaskAdmission } from "@shared/work-model";
import {
  ADMISSION_LABELS,
  ADMISSION_ORDER,
  admissionOutcome,
} from "../../lib/admission-labels";
import { parseWait } from "../rules/board-settings";

export const TASK_ADMISSION_CHOICES: ReadonlyArray<{
  readonly value: TaskAdmission;
  readonly label: string;
  readonly outcome: string;
}> = ADMISSION_ORDER.map((value) => ADMISSION_LABELS[value]);

export const admissionFloorOutcome = (floor: TaskAdmission): string =>
  admissionOutcome(floor);

/** Creation defaults to operator approval, unless the board floor is stricter. */
export const defaultTaskAdmission = (floor: TaskAdmission): TaskAdmission =>
  floor === "operator" ? "operator" : "approval";

export const taskAdmissionChoices = (floor: TaskAdmission) =>
  TASK_ADMISSION_CHOICES.map((choice) => ({
    ...choice,
    disabled: false,
    reason: undefined,
  }));

export type TaskWaitParse =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false; readonly message: string };

export const parseTaskWait = (raw: string): TaskWaitParse => {
  const parsed = parseWait(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "Use a duration such as 90m, 12h, or 7d.",
    };
  }
  if (parsed.ms !== undefined && parsed.ms > WAIT_FOR_MAX_MS) {
    return {
      ok: false,
      message: "Wait duration cannot exceed 90 days.",
    };
  }
  return parsed;
};
