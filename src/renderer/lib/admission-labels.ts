import type { TaskAdmission } from "@shared/work-model";

/** One label table for every admission surface. Short word + what it does. */
export type AdmissionLabels = {
  readonly value: TaskAdmission;
  readonly label: string;
  readonly outcome: string;
};

export const ADMISSION_LABELS: Readonly<Record<TaskAdmission, AdmissionLabels>> = {
  auto: {
    value: "auto",
    label: "Immediate",
    outcome: "Agents can start it right away",
  },
  approval: {
    value: "approval",
    label: "Approval",
    outcome: "Waits for my approval",
  },
  operator: {
    value: "operator",
    label: "Me",
    outcome: "I work it myself",
  },
};

export const ADMISSION_ORDER: ReadonlyArray<TaskAdmission> = [
  "auto",
  "approval",
  "operator",
];

export const admissionLabels = (admission: TaskAdmission): AdmissionLabels =>
  ADMISSION_LABELS[admission];

export const admissionLabel = (admission: TaskAdmission): string =>
  ADMISSION_LABELS[admission].label;

export const admissionOutcome = (admission: TaskAdmission): string =>
  ADMISSION_LABELS[admission].outcome;

export const admissionChoiceLabel = (admission: TaskAdmission): string => {
  const labels = ADMISSION_LABELS[admission];
  return `${labels.label} — ${labels.outcome}`;
};
