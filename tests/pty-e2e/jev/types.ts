/**
 * Workstream A — seat-awareness (Jev) evaluation harness: shared types.
 *
 * Everything here is DATA over a rendered terminal grid. No type in this file
 * carries a control-path value: there is no seat state, no composer verdict,
 * no `needsLook`, and no delivery decision. That is the authority boundary the
 * sidecar contract freezes, expressed as a type surface (cemented by
 * `authority.test.ts`, which refuses a control-path import in this directory).
 */

/** Where a chrome literal is read from on the observer's rendered state. */
export type ChromeWhere = "screen" | "title" | "osc9";

/**
 * How a checkpoint was selected. All three are read off the rendered screen
 * (or the observer's own title/OSC signals); none is derived from a model.
 */
export type CheckpointClass = "live_turn" | "dialog" | "settled_idle";

/** What a matched literal means for checkpoint selection. */
export type ChromeKind = "live_turn" | "dialog";

/** The four concern Nouls of the frozen question pack. */
export const CONCERNS = [
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
] as const;
export type ConcernId = (typeof CONCERNS)[number];

/**
 * One grounded chrome literal. `source`/`flags` are stored instead of a
 * `RegExp` so the committed manifest is JSON-serializable and reviewable.
 */
export type ChromeProbe = {
  readonly id: string;
  readonly kind: ChromeKind;
  /** Which checkpoint class a match on this probe selects. */
  readonly role: CheckpointClass;
  /** The concern this dialog answers, when `kind === "dialog"`. */
  readonly concern?: ConcernId;
  readonly where: ChromeWhere;
  readonly source: string;
  readonly flags: string;
  /** A verbatim example read off a capture (or the rule pack when unobserved). */
  readonly literal: string;
  /** Where this literal came from. Never "the rule engine matched it". */
  readonly provenance: string;
};

export type ChromeMatch = {
  readonly probeId: string;
  readonly kind: ChromeKind;
  readonly role: CheckpointClass;
  readonly concern?: ConcernId;
  readonly where: ChromeWhere;
  /** The screen/title text that matched, trimmed and bounded. */
  readonly matchedText: string;
};

/** One label: either a grounded value or an explicit abstention. */
export type Label = {
  readonly value: string;
  /** Why this value, in terms the reader can check against the screen. */
  readonly basis: string;
  /** The literal the label was read from, when it was read from one. */
  readonly literal?: string;
};

/** The nine answers the frozen pack asks for, labelled from the screen. */
export type LabelVector = {
  readonly activity: Label;
  readonly turn_in_progress: Label;
  readonly approval_requested: Label;
  readonly answer_requested: Label;
  readonly access_problem: Label;
  readonly execution_error: Label;
  readonly repetition: Label;
  readonly highlight_exists: Label;
  readonly highlight_line: Label;
};

/** The step grid a checkpoint was sampled on. */
export type StepGrid = "event" | "fraction";

/** Geometry recorded from the capture's own manifest, never a default. */
export type CaptureGeometry = {
  readonly cols: number;
  readonly rows: number;
  /** Which key of the capture manifest supplied it. */
  readonly source: string;
};

export type Checkpoint = {
  readonly id: string;
  readonly harness: string;
  readonly scenario: string;
  readonly class: CheckpointClass;
  readonly grid: StepGrid;
  /** 1-based index of the step within its grid. */
  readonly step: number;
  /** Total steps walked on that grid for this capture. */
  readonly steps: number;
  /** Decoded (UTF-16) offset the capture was replayed to — same unit the
   * parent's proof-of-concept cut on (`floor(blob.length * i / steps)`). */
  readonly cut: number;
  readonly cutFraction: number;
  readonly decodedLength: number;
  /** Raw PTY byte count of the capture (sum of decoded event bytes). */
  readonly rawBytes: number;
  /** Sampled cuts that shared this checkpoint's semantic signature. */
  readonly occurrences: number;
  readonly geometry: CaptureGeometry;
  readonly signals: { readonly title: string; readonly osc9: string };
  /** Every probe that matched this screen; `class` names the selecting one. */
  readonly matches: readonly ChromeMatch[];
  /** The id-tagged, 128-capped evidence window actually offered to the model. */
  readonly window: {
    readonly totalLines: number;
    readonly candidateLines: number;
    readonly firstId: string;
    readonly lastId: string;
  };
  readonly labels: LabelVector;
};

/** A scenario the committed corpus does not cover, with its declared reason. */
export type CoverageGap = {
  readonly harness: string;
  readonly scenario: string;
  /** `declared-skip` when the manifest names it, `absent` when it has no row. */
  readonly kind: "declared-skip" | "absent" | "undeclared-capture";
  readonly reason: string;
  /** What a checkpoint set loses by not having it. */
  readonly unblocks: readonly string[];
};

export type HarnessCoverage = {
  readonly harness: string;
  readonly captures: number;
  readonly scenarios: readonly string[];
  readonly checkpoints: number;
  readonly byClass: Readonly<Record<CheckpointClass, number>>;
  /** Probe ids declared for this harness that matched no cut in the corpus. */
  readonly unobservedProbes: readonly string[];
};

export type CheckpointManifest = {
  readonly version: 1;
  readonly generatedBy: string;
  readonly corpusRoot: string;
  readonly harnesses: readonly string[];
  readonly captures: number;
  readonly steps: { readonly fraction: number };
  readonly modelContract: {
    readonly packIds: readonly string[];
    readonly evidenceCap: number;
    readonly evidenceShape: string;
    readonly requestedModel: string;
    readonly returnedModelInParentRuns: string;
  };
  readonly checkpoints: readonly Checkpoint[];
  readonly coverage: {
    readonly byHarness: readonly HarnessCoverage[];
    readonly gaps: readonly CoverageGap[];
    readonly unobservedProbes: readonly string[];
  };
};
