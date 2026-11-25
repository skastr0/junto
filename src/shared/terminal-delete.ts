/** Why a remote seat's delete stop could not prove its receipt. */
export const DELETE_BINDING_UNPROVEN_REASONS = [
  "refused",
  "epoch-changed",
  "unreachable",
  "timeout",
] as const;

export type DeleteBindingUnprovenReason = (typeof DELETE_BINDING_UNPROVEN_REASONS)[number];
