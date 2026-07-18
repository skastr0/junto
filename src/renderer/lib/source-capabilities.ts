import type { EntitySource, SnapshotState } from "@shared/entities";

// Renderer-side read of SnapshotState.capabilities (detected in the main
// process, see src/main/vellum/source-capabilities.ts). Absent capabilities
// (the initial empty state, pre-detection fixtures) mean "everything
// enabled" so surfaces never flash hidden before the first snapshot push.
export const sourceEnabled = (snapshots: SnapshotState, source: EntitySource): boolean =>
  source === "hermes" || (snapshots.capabilities?.[source] ?? true);

export const anyPrivateSourceEnabled = (snapshots: SnapshotState): boolean =>
  (["tower", "quasar", "booth"] as const).some((source) => sourceEnabled(snapshots, source));
