import type { SinkAdmission } from "@shared/work-model";

/** One label table for every admission surface. Short word + what it does. */
export type AdmissionLabels = {
  readonly value: SinkAdmission;
  readonly label: string;
  readonly outcome: string;
};

export const ADMISSION_LABELS: Readonly<Record<SinkAdmission, AdmissionLabels>> = {
  auto: {
    value: "auto",
    label: "Immediate",
    outcome: "Agents can start it right away",
  },
  "operator-gated": {
    value: "operator-gated",
    label: "Approval",
    outcome: "Waits for my approval",
  },
  "operator-owned": {
    value: "operator-owned",
    label: "Me",
    outcome: "I work it myself",
  },
};

export const ADMISSION_ORDER: ReadonlyArray<SinkAdmission> = [
  "auto",
  "operator-gated",
  "operator-owned",
];

export const admissionLabels = (admission: SinkAdmission): AdmissionLabels =>
  ADMISSION_LABELS[admission];

export const admissionLabel = (admission: SinkAdmission): string =>
  ADMISSION_LABELS[admission].label;

export const admissionOutcome = (admission: SinkAdmission): string =>
  ADMISSION_LABELS[admission].outcome;

export const admissionChoiceLabel = (admission: SinkAdmission): string => {
  const labels = ADMISSION_LABELS[admission];
  return `${labels.label} — ${labels.outcome}`;
};
